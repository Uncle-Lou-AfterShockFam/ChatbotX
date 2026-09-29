import { formUploadService } from "@chatbotx.io/business/form"
import { distributedLock } from "@chatbotx.io/redis"
import { normalizeError } from "universal-error-normalizer"
import { logger } from "../../lib/logger"

const LOCK_TTL_SECONDS = 300
const BATCH_SIZE = 100
const MAX_BATCHES_PER_RUN = 50

/**
 * Hourly (s225a A2-4 PR 5): delete the web form uploads no submission
 * claimed within their TTL, and retry marked rows whose object delete
 * failed (see `formUploadService.sweepExpired`: mark and commit first, then
 * one object at a time, so a failing key holds back only its own row).
 */
export async function sweepFormUploads() {
  return await distributedLock.runExclusive({
    key: "schedule:sweep-form-uploads",
    timeoutInSeconds: LOCK_TTL_SECONDS,
    fn: async () => {
      let deleted = 0
      try {
        for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
          const batchResult = await formUploadService.sweepExpired({
            limit: BATCH_SIZE,
          })
          deleted += batchResult.deleted
          if (batchResult.marked < BATCH_SIZE) {
            break
          }
        }
      } catch (error) {
        logger.error(
          { err: normalizeError(error), deleted },
          "form upload sweep: stopped early",
        )
      }
      if (deleted > 0) {
        logger.info({ deleted }, "form upload sweep")
      }
      return { deleted }
    },
  })
}
