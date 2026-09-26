import { triggerEventTypes } from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"

/** Hub invoicing events (s205b): no sourceId, every invoice of the workspace. */
const invoiceCondition = <T extends InvoiceConditionType>(type: T) =>
  z.object({
    id: zodBigintAsString().optional(),
    type: z.literal(type),
  })

export const INVOICE_CONDITION_TYPES = [
  triggerEventTypes.enum.invoiceCreated,
  triggerEventTypes.enum.invoicePaid,
  triggerEventTypes.enum.invoicePaymentFailed,
] as const
type InvoiceConditionType = (typeof INVOICE_CONDITION_TYPES)[number]

export const invoiceCreated = invoiceCondition(
  triggerEventTypes.enum.invoiceCreated,
)
export const invoicePaid = invoiceCondition(triggerEventTypes.enum.invoicePaid)
export const invoicePaymentFailed = invoiceCondition(
  triggerEventTypes.enum.invoicePaymentFailed,
)
