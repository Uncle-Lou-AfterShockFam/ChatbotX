import {
  INVOICE_DESCRIPTION_MAX,
  INVOICE_MAX_DUE_DAYS,
  INVOICE_MAX_LINE_ITEMS,
  INVOICE_MAX_QUANTITY,
  INVOICE_MEMO_MAX,
  invoiceMethods,
  invoiceStatuses,
} from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"

/** Money is the numeric(14,2) string (`"25.00"`) plus an ISO currency. */
export const invoiceLineItemResource = z.object({
  position: z.number().int(),
  description: z.string(),
  quantity: z.number().int(),
  unitAmount: z.string(),
  amount: z.string(),
})

export const invoiceResource = z.object({
  id: z.string(),
  number: z.number().int(),
  status: invoiceStatuses,
  method: invoiceMethods,
  currency: z.string(),
  total: z.string(),
  memo: z.string().nullable(),
  contactId: z.string(),
  companyId: z.string().nullable(),
  dealId: z.string().nullable(),
  /** The provider's pay page; null while draft. */
  hostedUrl: z.string().nullable(),
  pdfUrl: z.string().nullable(),
  dueAt: z.date().nullable(),
  paidAt: z.date().nullable(),
  voidedAt: z.date().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})
export type InvoiceResource = z.infer<typeof invoiceResource>

export const invoiceDetailResource = invoiceResource.extend({
  lineItems: z.array(invoiceLineItemResource),
})
export type InvoiceDetailResource = z.infer<typeof invoiceDetailResource>

export const invoiceLineRequest = z
  .object({
    description: z
      .string()
      .trim()
      .min(1)
      .max(INVOICE_DESCRIPTION_MAX)
      .describe("What the line bills for, shown on the invoice."),
    quantity: z
      .number()
      .int()
      .min(1)
      .max(INVOICE_MAX_QUANTITY)
      .describe("Whole units of this line."),
    unitAmount: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .describe(
        'Price of one unit in major units as a string ("25.00"); parsed exactly, a decimal comma is rejected.',
      ),
  })
  .strict()

export const createInvoiceRequest = z
  .object({
    contactId: zodBigintAsString().describe(
      "The contact to bill (see `contacts.list`).",
    ),
    currency: z
      .string()
      .trim()
      .length(3)
      .describe(
        "ISO 4217 code, e.g. USD. Three-decimal currencies are not supported.",
      ),
    lines: z
      .array(invoiceLineRequest)
      .min(1)
      .max(INVOICE_MAX_LINE_ITEMS)
      .describe("The line items, in order."),
    dueInDays: z
      .number()
      .int()
      .min(0)
      .max(INVOICE_MAX_DUE_DAYS)
      .describe("Days until the invoice is due (Stripe applies at least 1)."),
    memo: z
      .string()
      .trim()
      .max(INVOICE_MEMO_MAX)
      .optional()
      .describe("Free text shown on the invoice."),
    dealId: zodBigintAsString()
      .optional()
      .describe("A deal to link the invoice to (see `deals.list`)."),
    idempotencyKey: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Replaying the same key returns the first invoice instead of billing twice.",
      ),
  })
  .strict()
export type CreateInvoiceRequest = z.infer<typeof createInvoiceRequest>

export const listInvoicesRequest = z.object({
  contactId: zodBigintAsString()
    .optional()
    .describe("Only invoices of this contact."),
  status: invoiceStatuses.optional().describe("Only invoices in this status."),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Page size, 1 to 100 (default 25)."),
  cursor: z
    .string()
    .max(64)
    .optional()
    .describe("The `nextCursor` of the previous page."),
})

export const listInvoicesResponse = z.object({
  data: z.array(invoiceResource),
  nextCursor: z.string().nullable(),
})

export const invoiceIdInput = z.object({
  id: zodBigintAsString().describe("The invoice id (see `invoices.list`)."),
})

/** The API never returns the Stripe ids or the source key. */
export const toInvoiceResource = <
  T extends InvoiceResource & Record<string, unknown>,
>(
  row: T,
): InvoiceResource => ({
  id: row.id,
  number: row.number,
  status: row.status,
  method: row.method,
  currency: row.currency,
  total: row.total,
  memo: row.memo,
  contactId: row.contactId,
  companyId: row.companyId,
  dealId: row.dealId,
  hostedUrl: row.hostedUrl,
  pdfUrl: row.pdfUrl,
  dueAt: row.dueAt,
  paidAt: row.paidAt,
  voidedAt: row.voidedAt,
  lastError: row.lastError,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})
