import { conversationService } from "@chatbotx.io/business"
import { formSessionService } from "@chatbotx.io/business/form"
import type { FormSessionModel } from "@chatbotx.io/database/types"
import { runWithWebhookExecutionContext } from "@chatbotx.io/events/context"
import { ASK_FORM_EXPIRED_PAYLOAD_TYPE } from "@chatbotx.io/flow-config"
import { distributedLock } from "@chatbotx.io/redis"
import {
  IntegrationJobAction,
  integrationQueue,
} from "@chatbotx.io/worker-config"
import { normalizeError } from "universal-error-normalizer"
import { logger } from "../../lib/logger"

const LOCK_TTL_SECONDS = 55
const BATCH_SIZE = 100
const MAX_BATCHES_PER_RUN = 20

/**
 * Every minute: end the chat form runs whose question timed out (s219 A2-2)
 * and route each flow down its askForm `skip` state. The row turns `expired`
 * first (SKIP LOCKED + status re-check, so a run being answered is never
 * double-ended); then the conversation challenge is cleared only if it is
 * still that question (compare-and-clear on stepId + challengeId); then the
 * flow re-enters the askForm step with an `askFormExpired` marker under a
 * deterministic job id, so a re-run of this sweep never routes twice.
 * A timed-out run also emits `formAbandoned` (s220 A2-3, claimed once per
 * run); a last catch-up pass emits for runs that ended but never got it.
 */
export async function sweepFormSessions() {
  return await distributedLock.runExclusive({
    key: "schedule:sweep-form-sessions",
    timeoutInSeconds: LOCK_TTL_SECONDS,
    fn: async () => {
      let expired = 0
      for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
        const rows = await formSessionService.expireDue({ limit: BATCH_SIZE })
        for (const row of rows) {
          await routeExpired(row)
          await emitAbandoned(row)
        }
        expired += rows.length
        if (rows.length < BATCH_SIZE) {
          break
        }
      }
      const abandonCatchUp = await asContactEvent(() =>
        formSessionService.emitPendingAbandons({ limit: BATCH_SIZE }),
      ).catch((error: unknown) => {
        logger.error(
          { err: normalizeError(error) },
          "form session sweep: formAbandoned catch-up failed",
        )
        return 0
      })
      if (expired > 0 || abandonCatchUp > 0) {
        logger.info({ expired, abandonCatchUp }, "form session sweep")
      }
      return { expired, abandonCatchUp }
    },
  })
}

async function routeExpired(row: FormSessionModel): Promise<void> {
  try {
    if (row.challengeId) {
      await conversationService.consumeChallenge({
        workspaceId: row.workspaceId,
        conversationId: row.conversationId,
        stepId: row.stepId,
        challengeId: row.challengeId,
      })
    }
    await integrationQueue.add(
      IntegrationJobAction.sendFlow,
      {
        type: IntegrationJobAction.sendFlow,
        data: {
          conversationId: row.conversationId,
          contactInboxId: row.contactInboxId,
          flowId: row.flowId,
          flowVersionId: row.flowVersionId ?? undefined,
          nodeId: row.nodeId,
          startFromStepId: row.stepId,
          metadata: {
            type: ASK_FORM_EXPIRED_PAYLOAD_TYPE,
            stepId: row.stepId,
            formSessionId: row.id,
          },
          runStartedAt: row.runStartedAt?.toISOString(),
        },
      },
      { jobId: `form-session-expired-${row.id}` },
    )
  } catch (error) {
    // The run is already `expired`: a lost re-entry leaves the flow parked,
    // never re-asks. Logged for the operator; the contact can restart it.
    logger.error(
      { err: normalizeError(error), formSessionId: row.id },
      "form session sweep: routing the expired run failed",
    )
  }
}

/**
 * A timed-out run is the CONTACT's doing (they stopped replying on the
 * channel), like the attempts end, which runs inside the received-message
 * handler's webhook context. Without it the webhook emitter drops the event,
 * so a `form_abandoned` webhook would see used-up attempts but never a
 * timeout (Codex probe, s220 A2-3).
 */
const asContactEvent = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithWebhookExecutionContext({ source: "webhook" }, fn)

async function emitAbandoned(row: FormSessionModel): Promise<void> {
  try {
    await asContactEvent(() => formSessionService.emitAbandoned(row))
  } catch (error) {
    // Unclaimed: the catch-up pass at the end of this sweep (or the next) retries it.
    logger.error(
      { err: normalizeError(error), formSessionId: row.id },
      "form session sweep: formAbandoned claim failed",
    )
  }
}
