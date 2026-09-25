import {
  type SmartDelayRow,
  smartDelayService,
} from "@chatbotx.io/business/smart-delay"
import { IntegrationJobAction } from "@chatbotx.io/worker-config"
import type { Job } from "bullmq"
import { normalizeError } from "universal-error-normalizer"
import { logger } from "../../lib/logger"
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
 * Run a claimed (`running`) smart delay's resume job. The claim (claimRunning
 * / claimForEvent) is the concurrency guard and its generation is the token:
 * the flow ends with finishClaimedRun(generation) -> completed; on a flow
 * failure requeueClaimedRun(generation) puts the row back to `scheduled` so
 * BullMQ's retry can claim and resume it again, then the error propagates so
 * the retry happens. While the flow runs, the claim is renewed every
 * CLAIM_HEARTBEAT_MS; a worker that dies stops renewing and the scanner's
 * stuck-running sweep recovers the row.
 */
export async function runClaimedSmartDelay(
  claimed: Pick<SmartDelayRow, "id" | "claimGeneration">,
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
  try {
    await runFlowNode(resumeJob.data.data, {
      flowExecutionKey: parentJob?.id,
    })
  } catch (error) {
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
  const finished = await smartDelayService.finishClaimedRun({
    id: smartDelayId,
    generation,
  })
  if (!finished) {
    // The sweep reset this row mid-run (a claim older than the grace) and
    // another resume may have run it again: log, never resurrect.
    logger.warn(
      { smartDelayId, generation },
      "Smart delay run finished but its claim was no longer current",
    )
  }
}
