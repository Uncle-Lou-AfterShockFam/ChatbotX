import { dealTaskService } from "@chatbotx.io/business/deal-task"
import { distributedLock } from "@chatbotx.io/redis"
import { logger } from "../../lib/logger"

const LOCK_TTL_SECONDS = 55

/**
 * Every 5 minutes: claim open tasks past their due date that were not
 * notified yet and emit `taskOverdue` once each (the claim column is the
 * truth; see dealTaskService.claimOverdue). The lock keeps two schedule
 * workers from scanning at once; SKIP LOCKED covers the rest.
 */
export async function scanDealTaskOverdue() {
  return await distributedLock.runExclusive({
    key: "schedule:scan-deal-task-overdue",
    timeoutInSeconds: LOCK_TTL_SECONDS,
    fn: async () => {
      const result = await dealTaskService.claimOverdue()
      if (result.scanned > 0) {
        logger.info(result, "deal-task overdue scan")
      }
      return result
    },
  })
}
