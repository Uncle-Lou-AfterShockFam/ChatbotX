import { buildJobId } from "@chatbotx.io/flow-config"
import { integrationQueue } from "@chatbotx.io/worker-config"
import { logger } from "../logger"
import type { SmartDelayRow } from "./service"

/**
 * Backoff between re-checks for rows a batch skipped because another
 * statement held their lock (a heartbeat / claim holds it for milliseconds).
 * About 1.5 s in total, bounded because the company stop runs on a request.
 */
export const LOCKED_ROW_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const

/**
 * Rows were still firable when the loop gave up: the batch cap was reached,
 * or a lock outlived the retries. Callers must report this as a failed /
 * partial stop, never as done.
 */
export class SmartDelayCancelIncompleteError extends Error {
  readonly canceled: number
  readonly reason: "batch-cap" | "locked-rows"

  constructor(props: {
    canceled: number
    reason: "batch-cap" | "locked-rows"
  }) {
    super(
      `smart-delay cancel incomplete (${props.reason}) after ${props.canceled} rows`,
    )
    this.name = "SmartDelayCancelIncompleteError"
    this.canceled = props.canceled
    this.reason = props.reason
  }
}

/**
 * The shared "cancel rows in bounded batches, then drop their jobs" loop
 * behind `cancelSmartDelaysForWorkspace` (workspace freeze) and the company
 * stop. Cancelling the ROW is what stops the work; the job removal is
 * best-effort because a wake-up job for a canceled row is already a no-op.
 *
 * `fetchBatch` is SKIP LOCKED (see `cancelActiveForWorkspace`), so a drained
 * loop is not proof that nothing is left: `hasRemaining` (non-locking) decides,
 * and skipped rows are retried with backoff. Returns the number of rows
 * canceled; throws `SmartDelayCancelIncompleteError` when rows remain.
 */
export async function runSmartDelayCancelLoop(props: {
  workspaceId: string
  batchSize: number
  maxBatches: number
  logLabel: string
  fetchBatch: (
    limit: number,
  ) => Promise<Pick<SmartDelayRow, "id" | "triggerAt">[]>
  hasRemaining: () => Promise<boolean>
}): Promise<number> {
  const { workspaceId, batchSize, maxBatches, logLabel, fetchBatch } = props
  let canceled = 0
  let batches = 0

  for (let attempt = 0; ; attempt += 1) {
    while (batches < maxBatches) {
      const rows = await fetchBatch(batchSize)
      if (rows.length === 0) {
        // Nothing takeable (skipped rows are locked): the retry budget, not
        // the batch cap, bounds these fetches.
        break
      }
      batches += 1
      canceled += rows.length
      await removeJobs(rows, workspaceId, logLabel)
      if (rows.length < batchSize) {
        break
      }
    }

    if (!(await props.hasRemaining())) {
      return canceled
    }
    if (batches >= maxBatches) {
      throw new SmartDelayCancelIncompleteError({
        canceled,
        reason: "batch-cap",
      })
    }
    const delay = LOCKED_ROW_RETRY_DELAYS_MS[attempt]
    if (delay === undefined) {
      throw new SmartDelayCancelIncompleteError({
        canceled,
        reason: "locked-rows",
      })
    }
    // No node:timers/promises: the business barrel must stay Edge-safe.
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
}

async function removeJobs(
  rows: Pick<SmartDelayRow, "id" | "triggerAt">[],
  workspaceId: string,
  logLabel: string,
): Promise<void> {
  if (rows.length === 0) {
    return
  }
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
}
