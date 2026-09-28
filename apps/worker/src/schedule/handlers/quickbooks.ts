import { refreshIdleQuickbooksTokens } from "@chatbotx.io/business/integration-quickbooks"
import {
  pollQuickbooksChanges,
  sweepInvoiceMirrors,
} from "@chatbotx.io/business/invoice"
import { distributedLock } from "@chatbotx.io/redis"
import { logger } from "../../lib/logger"

/** Each runs alone across schedule workers; a skipped tick is fine. */
const exclusive = <T>(key: string, seconds: number, fn: () => Promise<T>) =>
  distributedLock.runExclusive({
    key: `schedule:${key}`,
    timeoutInSeconds: seconds,
    retryTimeoutInSeconds: 1,
    fn,
  })

/** Every 15 min: the CDC backstop for lost QuickBooks webhooks (s214b). */
export const pollQuickbooksChangesSchedule = () =>
  exclusive("poll-quickbooks-changes", 600, async () => {
    const result = await pollQuickbooksChanges()
    if (result.queued > 0 || result.failed > 0) {
      logger.info(result, "quickbooks change poll")
    }
  })

/** Hourly: re-queue invoice mirrors that are missing or behind (s214b). */
export const sweepInvoiceMirrorsSchedule = () =>
  exclusive("sweep-invoice-mirrors", 600, async () => {
    const result = await sweepInvoiceMirrors()
    if (result.queued > 0) {
      logger.info(result, "invoice mirror sweep")
    }
  })

/** Daily: keep idle QuickBooks refresh tokens inside their rolling expiry. */
export const refreshQuickbooksTokensSchedule = () =>
  exclusive("refresh-quickbooks-tokens", 1800, async () => {
    const result = await refreshIdleQuickbooksTokens()
    if (result.refreshed > 0 || result.failed > 0) {
      logger.info(result, "quickbooks keep-alive refresh")
    }
  })
