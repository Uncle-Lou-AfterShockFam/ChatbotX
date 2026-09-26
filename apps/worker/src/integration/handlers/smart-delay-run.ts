import {
  type SmartDelayRow,
  smartDelayService,
} from "@chatbotx.io/business/smart-delay"
import { IntegrationJobAction } from "@chatbotx.io/worker-config"
import type { Job } from "bullmq"
import { normalizeError } from "universal-error-normalizer"
import { logger } from "../../lib/logger"
import { type ClaimCheck, ClaimLostError } from "./claim-lost"
import { runFlowNode } from "./flow"
import type { buildSendFlowResumeJob } from "./smart-delay"

/**
 * How often an in-flight run renews its claim. The scanner sweeps `running`
 * rows whose claimedAt is older than its 10-minute grace, so a run that is
 * slow but alive (a webhook, an AI step, a third-party retry) must renew
 * well inside that window or it would be re-run concurrently (skeptic HIGH).
 */
export const CLAIM_HEARTBEAT_MS = 2 * 60 * 1000

/**
 * Tries for a claim write the run depends on (claimCheck, finish). Each CAS
 * is idempotent, and a transient database error must not replay the edge:
 * a failed check would requeue + retry it from the start, a failed finish
 * would leave the row `running` until the sweep re-runs it.
 */
export const CLAIM_WRITE_ATTEMPTS = 3
const CLAIM_WRITE_BACKOFF_MS = 250

async function withClaimWriteRetry<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write()
    } catch (error) {
      if (attempt >= CLAIM_WRITE_ATTEMPTS) {
        throw error
      }
      await new Promise((resolve) =>
        setTimeout(resolve, CLAIM_WRITE_BACKOFF_MS * attempt),
      )
    }
  }
}

/**
 * Run a claimed (`running`) smart delay's resume job. The claim (claimRunning
 * / claimForEvent) is the concurrency guard and its generation is the token:
 * the flow ends with finishClaimedRun(generation) -> completed; on a flow
 * failure requeueClaimedRun(generation) puts the row back to `scheduled` so
 * BullMQ's retry can claim and resume it again, then the error propagates so
 * the retry happens. While the flow runs, the claim is renewed every
 * CLAIM_HEARTBEAT_MS; a worker that dies stops renewing and the scanner's
 * stuck-running sweep recovers the row.
 *
 * A run that is alive but could not renew for longer than the sweep grace
 * (a step stuck on a slow provider, a database stall) has had its row
 * handed to another resume. So before every step and every continuation
 * dispatch the runner re-checks the claim (claimCheck, a heartbeat CAS);
 * once it fails the run stops at that boundary and leaves the edge to the
 * new owner. A passing check also renews claimedAt, so nothing dispatched
 * within the sweep grace after it (including a step's own dispatch: a
 * condition branch, a new wait, a heavy job) can race a re-claim. The
 * accepted residual is one step that runs past the grace while no heartbeat
 * lands: that step, and whatever it dispatches, can run twice.
 */
export async function runClaimedSmartDelay(
  claimed: Pick<
    SmartDelayRow,
    "id" | "claimGeneration" | "workspaceId" | "contactInboxId"
  >,
  resumeJob: ReturnType<typeof buildSendFlowResumeJob>,
  parentJob?: Job,
): Promise<void> {
  if (resumeJob.data.type !== IntegrationJobAction.sendFlow) {
    return
  }
  const { id: smartDelayId, claimGeneration: generation } = claimed
  const heartbeat = setInterval(() => {
    smartDelayService
      .heartbeatClaim({ id: smartDelayId, generation })
      .then((renewed) => {
        if (!renewed) {
          logger.warn(
            { smartDelayId, generation },
            "Smart delay claim could not be renewed: it is no longer current",
          )
        }
      })
      .catch((err: unknown) => {
        logger.warn(
          { err: normalizeError(err), smartDelayId, generation },
          "Smart delay claim heartbeat failed",
        )
      })
  }, CLAIM_HEARTBEAT_MS)
  const claimCheck: ClaimCheck = async () => {
    const current = await withClaimWriteRetry(() =>
      smartDelayService.heartbeatClaim({ id: smartDelayId, generation }),
    )
    if (!current) {
      throw new ClaimLostError(smartDelayId, generation)
    }
  }
  try {
    // A stopped company's contact: the stop canceled every active row, but a
    // row it skipped (partial stop) or one written after its cancel pass can
    // still be claimed here. Cancel it instead of running the flow.
    if (
      await smartDelayService.isContactInboxStopped({
        workspaceId: claimed.workspaceId,
        contactInboxId: claimed.contactInboxId,
      })
    ) {
      await withClaimWriteRetry(() =>
        smartDelayService.finishClaimedRun({
          id: smartDelayId,
          generation,
          to: "canceled",
        }),
      )
      logger.info(
        { smartDelayId, generation },
        "Smart delay run canceled: the contact's company is stopped",
      )
      return
    }
    await runFlowNode(resumeJob.data.data, {
      flowExecutionKey: parentJob?.id,
      claimCheck,
    })
  } catch (error) {
    if (error instanceof ClaimLostError) {
      // Not a failure of this edge: the row is no longer this run's (swept
      // and re-claimed, canceled, or deleted). No requeue (the generation CAS
      // would refuse it), no retry, no finish.
      logger.warn(
        { smartDelayId, generation },
        "Smart delay run stopped: its claim is no longer current",
      )
      return
    }
    try {
      const requeued = await smartDelayService.requeueClaimedRun({
        id: smartDelayId,
        generation,
      })
      if (requeued === null) {
        logger.error(
          { smartDelayId, generation },
          "Failed to requeue a claimed smart delay after flow failure",
        )
      } else if (requeued === "failed") {
        logger.error(
          { smartDelayId, generation, err: normalizeError(error) },
          "Smart delay resume failed on its last allowed claim; row marked failed",
        )
      }
    } catch (requeueError) {
      logger.error(
        { err: normalizeError(requeueError), smartDelayId, generation },
        "Failed to requeue a claimed smart delay after flow failure",
      )
    }
    throw error
  } finally {
    clearInterval(heartbeat)
  }
  const finished = await withClaimWriteRetry(() =>
    smartDelayService.finishClaimedRun({ id: smartDelayId, generation }),
  )
  if (!finished) {
    // The row left this claim mid-run (swept and maybe re-run, canceled, or
    // deleted): log, never resurrect.
    logger.warn(
      { smartDelayId, generation },
      "Smart delay run finished but its claim was no longer current",
    )
  }
}
