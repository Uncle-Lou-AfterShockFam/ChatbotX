import { buildJobId } from "@chatbotx.io/flow-config"
import { integrationQueue } from "@chatbotx.io/worker-config"
import { logger } from "../logger"
import type { SmartDelayRow } from "./service"

/**
 * The shared "cancel rows in bounded batches, then drop their jobs" loop
 * behind `cancelSmartDelaysForWorkspace` (workspace freeze) and the company
 * stop. Cancelling the ROW is what stops the work; the job removal is
 * best-effort because a wake-up job for a canceled row is already a no-op.
 * Returns the number of rows canceled.
 */
export async function runSmartDelayCancelLoop(props: {
  workspaceId: string
  batchSize: number
  maxBatches: number
  logLabel: string
  fetchBatch: (
    limit: number,
  ) => Promise<Pick<SmartDelayRow, "id" | "triggerAt">[]>
}): Promise<number> {
  const { workspaceId, batchSize, maxBatches, logLabel, fetchBatch } = props
  let canceled = 0

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = await fetchBatch(batchSize)
    if (rows.length === 0) {
      break
    }
    canceled += rows.length

    // Never let a Redis hiccup abort the cancellation loop.
    const removals = await Promise.allSettled(
      rows.map((row) =>
        integrationQueue.remove(buildJobId(row.id, row.triggerAt)),
      ),
    )
    const failed = removals.filter((result) => result.status === "rejected")
    if (failed.length > 0) {
      logger.warn(
        { failedCount: failed.length, workspaceId },
        `${logLabel}: failed to remove smart-delay jobs`,
      )
    }

    if (rows.length < batchSize) {
      break
    }
  }

  return canceled
}
