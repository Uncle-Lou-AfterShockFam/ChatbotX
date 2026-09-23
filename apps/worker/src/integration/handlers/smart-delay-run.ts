import { smartDelayService } from "@chatbotx.io/business/smart-delay"
import { IntegrationJobAction } from "@chatbotx.io/worker-config"
import type { Job } from "bullmq"
import { normalizeError } from "universal-error-normalizer"
import { logger } from "../../lib/logger"
import { runFlowNode } from "./flow"
import type { buildSendFlowResumeJob } from "./smart-delay"

/**
 * Run a claimed smart delay's resume job. The claim (claimForRun /
 * claimForEvent) is the concurrency guard: on a flow failure the row goes back
 * to `scheduled` so BullMQ's retry can claim and resume it again, then the
 * error propagates so the retry happens.
 */
export async function runClaimedSmartDelay(
  smartDelayId: string,
  resumeJob: ReturnType<typeof buildSendFlowResumeJob>,
  parentJob?: Job,
  /** Passed by the waitForEvent event path: the edge to keep on a requeue. */
  resumeAt?: { nodeId: string; triggerAt: Date },
): Promise<void> {
  if (resumeJob.data.type !== IntegrationJobAction.sendFlow) {
    return
  }
  try {
    await runFlowNode(resumeJob.data.data, {
      flowExecutionKey: parentJob?.id,
    })
  } catch (error) {
    try {
      const requeued = await smartDelayService.requeueClaimedRun({
        id: smartDelayId,
        ...(resumeAt ? { resumeAt } : {}),
      })
      if (!requeued) {
        logger.error(
          { smartDelayId },
          "Failed to requeue a claimed smart delay after flow failure",
        )
      }
    } catch (requeueError) {
      logger.error(
        { err: normalizeError(requeueError), smartDelayId },
        "Failed to requeue a claimed smart delay after flow failure",
      )
    }
    throw error
  }
}
