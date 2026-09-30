import { pageService } from "@chatbotx.io/business/page"
import { distributedLock } from "@chatbotx.io/redis"
import { normalizeError } from "universal-error-normalizer"
import { logger } from "../../lib/logger"

const LOCK_TTL_SECONDS = 300
const BATCH_SIZE = 1000
const MAX_BATCHES_PER_RUN = 50

/**
 * Daily (s227a, B4): delete page links that expired more than
 * PAGE_LINK_RETAIN_DAYS ago (DB rows only; a page link owns no object).
 * Bounded per run; the rest waits for the next run.
 */
export async function sweepPageLinks() {
  return await distributedLock.runExclusive({
    key: "schedule:sweep-page-links",
    timeoutInSeconds: LOCK_TTL_SECONDS,
    fn: async () => {
      let deleted = 0
      try {
        for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
          const count = await pageService.sweepExpired({ batch: BATCH_SIZE })
          deleted += count
          if (count < BATCH_SIZE) {
            break
          }
        }
      } catch (error) {
        logger.error(
          { err: normalizeError(error), deleted },
          "page link sweep: stopped early",
        )
      }
      if (deleted > 0) {
        logger.info({ deleted }, "page link sweep")
      }
      return { deleted }
    },
  })
}
