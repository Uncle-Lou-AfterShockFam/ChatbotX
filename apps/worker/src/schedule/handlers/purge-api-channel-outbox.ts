import { purgeSettledApiChannelOutbox } from "@chatbotx.io/database/repositories"
import { getChildLogger } from "@chatbotx.io/logger"

const log = getChildLogger("purge-api-channel-outbox")

/** Settled (acked/refused) pull-mode rows are kept this long for audit. */
const RETENTION_DAYS = 30
const CHUNK_SIZE = 1000
const INTER_CHUNK_DELAY_MS = 100
const MAX_RUN_DURATION_MS = 10 * 60 * 1000
const MAX_CHUNKS_PER_RUN = 10_000

/**
 * `ApiChannelOutbox` grows one row per outbound message on every pull-mode
 * inbox and nothing else removes a settled row. Only settled rows are
 * purged (see the repository); an unsettled backlog is left alone as the
 * signal that a worker is not collecting.
 */
export async function purgeApiChannelOutbox(): Promise<void> {
  const { deleted, stopReason } = await purgeSettledApiChannelOutbox({
    retentionDays: RETENTION_DAYS,
    chunkSize: CHUNK_SIZE,
    interChunkDelayMs: INTER_CHUNK_DELAY_MS,
    maxChunks: MAX_CHUNKS_PER_RUN,
    maxRunDurationMs: MAX_RUN_DURATION_MS,
  })

  if (stopReason !== "drained") {
    log.warn(
      { deleted, stopReason },
      "purgeApiChannelOutbox: stopped with a backlog remaining",
    )
    return
  }

  if (deleted > 0) {
    log.info({ deleted }, "purgeApiChannelOutbox: rows purged")
  }
}
