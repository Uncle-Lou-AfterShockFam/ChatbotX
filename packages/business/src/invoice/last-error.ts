import { and, db, eq, isNull, sql } from "@chatbotx.io/database/client"
import { invoiceModel } from "@chatbotx.io/database/schema"

/**
 * `lastError` only while it is empty: a note written after the void must
 * not bury one a webhook wrote meanwhile (paid-after-void: "refund it").
 */
export async function recordLastErrorIfClear(
  invoiceId: string,
  message: string,
): Promise<void> {
  await db
    .update(invoiceModel)
    .set({ lastError: message.slice(0, 1000), updatedAt: new Date() })
    .where(and(eq(invoiceModel.id, invoiceId), isNull(invoiceModel.lastError)))
}

/** `lastError` is bounded; the newest notes are the ones kept. */
export const LAST_ERROR_MAX = 2000

/**
 * s235: the SQL value that APPENDS `note` to `lastError`, keeping earlier
 * operator notes (a "refund it" flag must survive a later refund note). One
 * statement, so concurrent appends never lose each other; a note already
 * there is not added again (a pay-page error repeats on every visit). Use it
 * for every note an operator must act on; `recordLastErrorIfClear` is the
 * only other policy.
 */
export const appendLastError = (note: string) =>
  sql<string>`CASE WHEN strpos(coalesce(${invoiceModel.lastError}, ''), ${note}) > 0 THEN ${invoiceModel.lastError} ELSE right(coalesce(${invoiceModel.lastError} || ' | ', '') || ${note}, ${LAST_ERROR_MAX}) END`

/** s235: the prefix of a pay-page refusal note, which a later good visit clears. */
export const PAY_PAGE_NOTE_PREFIX = "Pay page: "

/** A pay-page note, with the " | " that joined it to the note before it. */
const PAY_PAGE_NOTE_PATTERN = `${String.raw`(^|\| )`}${PAY_PAGE_NOTE_PREFIX}[^|]*`
/** The " | " left at the start when the first note was a pay-page one. */
const LEADING_SEPARATOR_PATTERN = String.raw`^ ?\| `

/**
 * `lastError` without its pay-page notes (s207b: a later good visit heals
 * them) and with every other note kept (s235: a refund note, a "refund it"
 * flag). Null when nothing is left.
 */
export const clearPayPageNotes = () =>
  sql<
    string | null
  >`nullif(btrim(regexp_replace(regexp_replace(coalesce(${invoiceModel.lastError}, ''), ${PAY_PAGE_NOTE_PATTERN}, '', 'g'), ${LEADING_SEPARATOR_PATTERN}, '')), '')`
