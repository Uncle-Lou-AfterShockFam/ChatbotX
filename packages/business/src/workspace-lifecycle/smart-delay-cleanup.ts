import { runSmartDelayCancelLoop } from "../smart-delay/cancel-loop"
import { smartDelayService } from "../smart-delay/service"

export const SMART_DELAY_CANCEL_BATCH_SIZE = 500
// Backstop so one workspace with a runaway backlog cannot spin the freeze call
// forever: 500 * 400 = 200k rows per call. Whatever is left is harmless — the
// worker-side guard no-ops those wake-ups, and the purge cascade removes the
// rows when the grace window expires.
const MAX_CANCEL_BATCHES = 400

/**
 * Cancels every still-firable smart-delay row of a workspace (wait steps,
 * follow-ups) and drops their delayed BullMQ jobs.
 *
 * Cancelling the row is the part that matters. A wake-up job for a `canceled`
 * row is already a no-op (`wait-resume` requires `status === 'scheduled'` and
 * `claimForRun` CASes on it), and — more importantly — the scanner's
 * stuck-scheduled sweeper can only reset rows that are still `scheduled`, so a
 * canceled row stops churning through claim → drop → reset for the rest of the
 * 24-hour grace window.
 */
export async function cancelSmartDelaysForWorkspace(props: {
  workspaceId: string
}): Promise<number> {
  return await runSmartDelayCancelLoop({
    workspaceId: props.workspaceId,
    batchSize: SMART_DELAY_CANCEL_BATCH_SIZE,
    maxBatches: MAX_CANCEL_BATCHES,
    logLabel: "workspace-freeze",
    fetchBatch: (limit) =>
      smartDelayService.cancelActiveForWorkspace({
        limit,
        workspaceId: props.workspaceId,
      }),
  })
}
