import { smartDelayService } from "@chatbotx.io/business/smart-delay"
import {
  smartDelayStatuses,
  smartDelayTypes,
} from "@chatbotx.io/database/partials"
import type { IntegrationJobResumeWait } from "@chatbotx.io/worker-config"
import type { Job } from "bullmq"
import { buildSendFlowResumeJob } from "./smart-delay"
import { runClaimedSmartDelay } from "./smart-delay-run"

export async function runWaitResume(
  data: IntegrationJobResumeWait["data"],
  parentJob?: Job,
): Promise<void> {
  const row = await smartDelayService.findById({ id: data.smartDelayId })
  if (
    !row ||
    row.type !== smartDelayTypes.enum.waitNode ||
    row.status !== smartDelayStatuses.enum.scheduled ||
    !row.nodeId
  ) {
    return
  }

  if (row.triggerAt.getTime() > Date.now()) {
    return
  }

  const claimed = await smartDelayService.claimForRun({
    id: row.id,
    to: smartDelayStatuses.enum.completed,
  })
  if (!claimed) {
    return
  }

  await runClaimedSmartDelay(row.id, buildSendFlowResumeJob(row), parentJob)
}
