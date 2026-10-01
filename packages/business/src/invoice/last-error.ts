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
 * statement, so concurrent appends never lose each other. The third policy
 * beside overwrite and `recordLastErrorIfClear`: use it for any note an
 * operator must act on.
 */
export const appendLastError = (note: string) =>
  sql<string>`right(coalesce(${invoiceModel.lastError} || ' | ', '') || ${note}, ${LAST_ERROR_MAX})`
