import { conversationService } from "@chatbotx.io/business"
import {
  formSessionService,
  formVisitService,
} from "@chatbotx.io/business/form"
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
 * Then the web pass (s224a A2-4): personal-link visits idle past their
 * form's `abandonAfterMinutes` emit `formAbandoned` channel web, and closed
 * visits past retention are pruned.
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
      const web = await sweepWebVisits()
      if (expired > 0 || abandonCatchUp > 0 || web.claimed > 0) {
        logger.info(
          { expired, abandonCatchUp, webAbandoned: web.emitted },
          "form session sweep",
        )
      }
      return { expired, abandonCatchUp, webAbandoned: web.emitted }
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

/**
 * The web half: claim-then-emit in batches, inside the same contact-event
 * webhook context as chat (the visitor stopped, like a chat timeout). A
 * failed claim is retried next minute; a claimed visit whose emit fails is
 * lost and logged (at most once, as chat). The prune runs on its own, so a
 * failed pass never stops it, and neither blocks the chat half above.
 */
async function sweepWebVisits(): Promise<{ claimed: number; emitted: number }> {
  let claimed = 0
  let emitted = 0
  try {
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      const result = await asContactEvent(() =>
        formVisitService.emitDueAbandons({ limit: BATCH_SIZE }),
      )
      claimed += result.claimed
      emitted += result.emitted
      if (result.claimed < BATCH_SIZE) {
        break
      }
    }
  } catch (error) {
    logger.error(
      { err: normalizeError(error) },
      "form session sweep: web visit pass failed",
    )
  }
  await formVisitService
    .pruneClosed()
    .catch((error: unknown) =>
      logger.error(
        { err: normalizeError(error) },
        "form session sweep: web visit prune failed",
      ),
    )
  return { claimed, emitted }
}
