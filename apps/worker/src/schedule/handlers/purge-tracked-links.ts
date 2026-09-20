import { purgeTrackedLinks as purgeTrackedLinkRows } from "@chatbotx.io/database/repositories"
import { getChildLogger } from "@chatbotx.io/logger"

const log = getChildLogger("purge-tracked-links")

/** A short link keeps resolving this long; after that it is a 404. */
const RETENTION_DAYS = 90
const CHUNK_SIZE = 1000
const INTER_CHUNK_DELAY_MS = 100
const MAX_RUN_DURATION_MS = 10 * 60 * 1000
const MAX_CHUNKS_PER_RUN = 10_000

/**
 * `TrackedLink` grows one row per URL per tracked text. Chunked and
 * deadline-bounded like `purgeErrorLogs` so a big campaign's backlog never
 * blocks the worker minting new links.
 */
export async function purgeTrackedLinks(): Promise<void> {
  const { deleted, stopReason } = await purgeTrackedLinkRows({
    retentionDays: RETENTION_DAYS,
    chunkSize: CHUNK_SIZE,
    interChunkDelayMs: INTER_CHUNK_DELAY_MS,
    maxChunks: MAX_CHUNKS_PER_RUN,
    maxRunDurationMs: MAX_RUN_DURATION_MS,
  })

  if (stopReason !== "drained") {
    log.warn(
      { deleted, stopReason },
      "purgeTrackedLinks: stopped with a backlog remaining",
    )
    return
  }

  if (deleted > 0) {
    log.info({ deleted }, "purgeTrackedLinks: rows purged")
  }
}
