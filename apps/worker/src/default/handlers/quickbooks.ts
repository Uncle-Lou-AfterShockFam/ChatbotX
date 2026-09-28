import {
  processQuickbooksChange,
  syncInvoiceMirror,
} from "@chatbotx.io/business/invoice"
import {
  type JobQuickbooksEntityChangedData,
  type JobSyncInvoiceMirrorData,
  jobQuickbooksEntityChangedDataSchema,
  jobSyncInvoiceMirrorDataSchema,
} from "@chatbotx.io/worker-config"
import { type Job, UnrecoverableError } from "bullmq"
import { normalizeError } from "universal-error-normalizer"
import { isFinalAttempt } from "../../lib/job-attempts"
import { logger } from "../../lib/logger"

/**
 * A QBO Invoice / Payment changed (s214b): settle the `quickbooks` invoices
 * it touches. A malformed job is dropped; a QBO or database failure is
 * retried by BullMQ and logged once, on the last attempt.
 */
export async function quickbooksEntityChanged(
  rawData: JobQuickbooksEntityChangedData,
  job: Job,
): Promise<void> {
  const parsed = jobQuickbooksEntityChangedDataSchema.safeParse(rawData)
  if (!parsed.success) {
    throw new UnrecoverableError("quickbooksEntityChanged: malformed job")
  }
  try {
    const outcomes = await processQuickbooksChange(parsed.data)
    if (outcomes.some((o) => o !== "unchanged" && o !== "not-hub")) {
      logger.info({ ...parsed.data, outcomes }, "quickbooks change settled")
    }
  } catch (error) {
    if (isFinalAttempt(job)) {
      logger.error(
        { err: normalizeError(error), ...parsed.data },
        "quickbooks change could not be settled",
      )
    }
    throw error
  }
}

/** Converge one invoice's QuickBooks copy (s214b); see syncInvoiceMirror. */
export async function syncInvoiceMirrorJob(
  rawData: JobSyncInvoiceMirrorData,
  job: Job,
): Promise<void> {
  const parsed = jobSyncInvoiceMirrorDataSchema.safeParse(rawData)
  if (!parsed.success) {
    throw new UnrecoverableError("syncInvoiceMirror: malformed job")
  }
  try {
    const outcome = await syncInvoiceMirror(parsed.data)
    if (outcome === "failed-permanent") {
      logger.warn(parsed.data, "invoice mirror gave up (see its lastError)")
    }
  } catch (error) {
    if (isFinalAttempt(job)) {
      logger.error(
        { err: normalizeError(error), ...parsed.data },
        "invoice mirror sync failed",
      )
    }
    throw error
  }
}
