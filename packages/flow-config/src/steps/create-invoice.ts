import { createId, zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import {
  errorStateDefaultFn,
  errorStateSchema,
  successStateDefaultFn,
  successStateSchema,
} from "../states"
import { stepTypes } from "./step-action"

export const CREATE_INVOICE_MAX_LINES = 20

export const createInvoiceLineSchema = z.object({
  /** May carry `{{variable}}` tokens. */
  description: z.string().trim().max(500).default(""),
  quantity: z.number().int().min(1).max(10_000).default(1),
  /** A money amount in major units ("12.50") or a token resolving to one. */
  unitAmount: z.string().trim().max(64).default(""),
})
export type CreateInvoiceLine = z.infer<typeof createInvoiceLineSchema>

/**
 * Invoice the conversation's contact through the workspace's own Stripe
 * (hub invoicing, s205b). Success writes the pay link to the contact field
 * `invoice_link` and the hub invoice id to `invoice_last_id` for a following
 * text step; a payment sets `invoice_paid_id` and tags `invoice-paid`, so a
 * `wait` step on `customFieldChanged invoice_paid_id = {{raw:invoice_last_id}}`
 * resumes on THIS invoice. Error: Stripe not connected, a bad amount, or a
 * Stripe failure. Retry-safe: one invoice per flow run and step.
 */
export const createInvoiceStepSchema = z.object({
  id: zodBigintAsString(),
  stepType: z.literal(stepTypes.enum.createInvoice),
  lines: z
    .array(createInvoiceLineSchema)
    .max(CREATE_INVOICE_MAX_LINES)
    .default([]),
  /** 3-letter ISO code. */
  currency: z.string().trim().max(3).default("USD"),
  dueInDays: z.number().int().min(0).max(365).default(7),
  /** Shown on the invoice; may carry `{{variable}}` tokens. */
  memo: z.string().trim().max(1000).default(""),
  /**
   * How it is collected (s207b): `default` = the workspace's Stripe setting;
   * `stripeCheckout` texts a stable `/pay` link and saves no card.
   */
  method: z
    .enum(["default", "stripeInvoice", "stripeCheckout"])
    .default("default"),
  states: z.tuple([successStateSchema, errorStateSchema]),
})
export type CreateInvoiceStepSchema = z.infer<typeof createInvoiceStepSchema>

export const createInvoiceStepDefaultFn = (): CreateInvoiceStepSchema => ({
  id: createId(),
  stepType: stepTypes.enum.createInvoice,
  lines: [{ description: "", quantity: 1, unitAmount: "" }],
  currency: "USD",
  dueInDays: 7,
  memo: "",
  method: "default",
  states: [successStateDefaultFn(), errorStateDefaultFn()],
})
