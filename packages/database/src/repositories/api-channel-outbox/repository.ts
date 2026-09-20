import { sql } from "../../client"
import { type ChunkedPurgeStopReason, chunkedPurge } from "../chunked-purge"

export type PurgeApiChannelOutboxOptions = {
  retentionDays: number
  chunkSize: number
  interChunkDelayMs: number
  maxChunks: number
  maxRunDurationMs?: number
}

/**
 * Retention for `ApiChannelOutbox`: only SETTLED rows (`acked`, `refused`)
 * age out, by the instant they were settled. `pending` and `leased` rows are
 * sends the hub still owes a worker that has not collected them; deleting
 * those would silently drop a text, so they stay until a worker settles
 * them (their depth is the operator's signal that a worker is down).
 */
export function purgeSettledApiChannelOutbox(
  options: PurgeApiChannelOutboxOptions,
): Promise<{ deleted: number; stopReason: ChunkedPurgeStopReason }> {
  const { retentionDays, ...bounds } = options
  return chunkedPurge({
    table: "ApiChannelOutbox",
    where: sql`"status" IN ('acked', 'refused') AND "ackedAt" < NOW() - make_interval(days => ${retentionDays})`,
    orderBy: "ackedAt",
    ...bounds,
  })
}
