import { sql } from "../../client"
import { type ChunkedPurgeStopReason, chunkedPurge } from "../chunked-purge"

export type PurgeTrackedLinksOptions = {
  retentionDays: number
  chunkSize: number
  interChunkDelayMs: number
  maxChunks: number
  maxRunDurationMs?: number
}

/**
 * Retention for `TrackedLink`: a short link older than the window stops
 * resolving (404) and its click history goes with it. Every row ages out,
 * clicked or not — the contact keeps the tag and field the click wrote.
 */
export function purgeTrackedLinks(
  options: PurgeTrackedLinksOptions,
): Promise<{ deleted: number; stopReason: ChunkedPurgeStopReason }> {
  const { retentionDays, ...bounds } = options
  return chunkedPurge({
    table: "TrackedLink",
    where: sql`"createdAt" < NOW() - make_interval(days => ${retentionDays})`,
    orderBy: "createdAt",
    ...bounds,
  })
}
