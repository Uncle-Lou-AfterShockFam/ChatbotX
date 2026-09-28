import { and, db, eq, isNull } from "@chatbotx.io/database/client"
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
