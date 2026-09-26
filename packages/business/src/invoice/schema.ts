import {
  INVOICE_DESCRIPTION_MAX,
  INVOICE_MAX_DUE_DAYS,
  INVOICE_MAX_LINE_ITEMS,
  INVOICE_MAX_QUANTITY,
  INVOICE_MEMO_MAX,
} from "@chatbotx.io/database/partials"
import { z } from "zod"

const idSchema = z.string().regex(/^\d{1,20}$/, "must be an id")

export const invoiceLineInputSchema = z
  .object({
    description: z.string().trim().min(1).max(INVOICE_DESCRIPTION_MAX),
    quantity: z.number().int().min(1).max(INVOICE_MAX_QUANTITY),
    /** Major units, parsed exactly ("12.50", 12.5). */
    unitAmount: z.union([z.string().trim().min(1).max(32), z.number()]),
  })
  .strict()
export type InvoiceLineInput = z.infer<typeof invoiceLineInputSchema>

export const createInvoiceInputSchema = z
  .object({
    workspaceId: idSchema,
    contactId: idSchema,
    currency: z.string().trim().length(3),
    lines: z.array(invoiceLineInputSchema).min(1).max(INVOICE_MAX_LINE_ITEMS),
    dueDays: z.number().int().min(0).max(INVOICE_MAX_DUE_DAYS),
    memo: z.string().trim().max(INVOICE_MEMO_MAX).optional(),
    dealId: idSchema.optional(),
    /** Idempotency: the same key in a workspace returns the first invoice. */
    sourceKey: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
export type CreateInvoiceInput = z.input<typeof createInvoiceInputSchema>

export const invoiceRefSchema = z
  .object({
    workspaceId: idSchema,
    id: idSchema,
    restrictToAssignedUserId: idSchema.optional(),
  })
  .strict()
export type InvoiceRef = z.infer<typeof invoiceRefSchema>

export const listInvoicesInputSchema = z
  .object({
    workspaceId: idSchema,
    contactId: idSchema.optional(),
    status: z
      .enum(["draft", "open", "paid", "void", "uncollectible", "refunded"])
      .optional(),
    limit: z.number().int().min(1).max(100).default(25),
    /** s193 assigned-only member: only invoices of contacts assigned to them. */
    restrictToAssignedUserId: idSchema.optional(),
    /** Opaque keyset cursor from a previous page. */
    cursor: z
      .string()
      .regex(/^\d{1,20}_\d{1,20}$/)
      .optional(),
  })
  .strict()
export type ListInvoicesInput = z.input<typeof listInvoicesInputSchema>
