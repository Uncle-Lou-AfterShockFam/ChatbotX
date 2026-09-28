import {
  DefaultJobAction,
  defaultQueue,
  type JobQuickbooksEntityChangedData,
} from "@chatbotx.io/worker-config"

/**
 * One job per entity, source and minute: a burst of webhook updates
 * collapses, while a CDC poll or a later minute gets its own job (a job that
 * already failed under one id never blocks the next reading).
 */
export const quickbooksEntityJobId = (
  data: JobQuickbooksEntityChangedData,
  source: "webhook" | "poll" | "open",
) =>
  `qbo-change-${source}-${data.integrationId}-${data.entity}-${data.entityId}-${Math.floor(Date.now() / 60_000)}`

export async function enqueueQuickbooksChange(
  data: JobQuickbooksEntityChangedData,
  source: "webhook" | "poll" | "open",
  delayMs = 0,
): Promise<void> {
  await defaultQueue.add(
    DefaultJobAction.quickbooksEntityChanged,
    { type: DefaultJobAction.quickbooksEntityChanged, data },
    { jobId: quickbooksEntityJobId(data, source), delay: delayMs },
  )
}
