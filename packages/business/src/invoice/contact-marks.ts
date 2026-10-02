import { and, db, eq } from "@chatbotx.io/database/client"
import { invoicePdfUrl } from "@chatbotx.io/database/partials"
import { invoiceModel } from "@chatbotx.io/database/schema"
import type { InvoiceModel } from "@chatbotx.io/database/types"
import { customFieldResolutionKey } from "@chatbotx.io/utils/custom-field"
import { contactCustomFieldService } from "../contact-custom-field/service"
import { customFieldService } from "../custom-field/service"
import { logger } from "../logger"
import { tagService } from "../tag/service"

/**
 * What an invoice writes onto its contact so a flow can branch or WAIT on it:
 * - `invoice_link` / `invoice_last_id`: the latest invoice (written when it
 *   opens, whichever path created it: flow step, Invoices page or /v1)
 * - `invoice_pdf_link`: its PDF (hub `/pay/<t>/pdf` for stripeCheckout and
 *   woocommerce, which serves the receipt once paid; Stripe's PDF for
 *   stripeInvoice; "" for a woocommerce invoice opened before s213b)
 * - `invoice_last_status`: the status of the invoice `invoice_last_id` names,
 *   from its row (`open`, `paid`, `partiallyPaid`, ...), or `payment_failed`
 *   while that invoice is open and its last payment attempt failed (s237)
 * - `invoice_failed_id`: the latest invoice whose payment FAILED while it was
 *   the latest and open (s237); an older invoice's failure is not recorded
 * - `invoice_paid_id`: the id of the invoice that was just PAID. A flow waits
 *   per invoice with `customFieldChanged` on it and matchValue
 *   `{{raw:invoice_last_id}}` (the wait captures the id at wait start).
 * - tag `invoice-paid` on every payment (emitFor "all": a second paid invoice
 *   must still wake a tagApplied wait).
 * - s216b deposit: status `partiallyPaid`, `invoice_deposit_paid_id` = the
 *   invoice id, tag `invoice-deposit-paid` (emitFor "all"). `invoice_paid_id`
 *   and `invoice-paid` stay for the FULL payment only, so a wait on them
 *   never wakes on a deposit.
 */
export const INVOICE_LINK_FIELD = "invoice_link"
export const INVOICE_PDF_LINK_FIELD = "invoice_pdf_link"
export const INVOICE_LAST_ID_FIELD = "invoice_last_id"
export const INVOICE_LAST_STATUS_FIELD = "invoice_last_status"
export const INVOICE_PAID_ID_FIELD = "invoice_paid_id"
export const INVOICE_PAID_TAG = "invoice-paid"
export const INVOICE_DEPOSIT_PAID_ID_FIELD = "invoice_deposit_paid_id"
export const INVOICE_DEPOSIT_PAID_TAG = "invoice-deposit-paid"
export const INVOICE_FAILED_ID_FIELD = "invoice_failed_id"

async function setFields(props: {
  workspaceId: string
  contactId: string
  contactInboxId?: string
  values: Record<string, string>
}): Promise<Map<string, string>> {
  const fields = Object.keys(props.values).map((name) => ({
    name,
    type: "shortText" as const,
  }))
  const { idMap } = await customFieldService.resolveByNameAndType({
    workspaceId: props.workspaceId,
    fields,
  })
  /** field name -> custom field id, for a read-back. */
  const ids = new Map<string, string>()
  for (const field of fields) {
    const id = idMap.get(customFieldResolutionKey(field))
    if (id) {
      ids.set(field.name, id)
    }
    await contactCustomFieldService.setValueByKey({
      workspaceId: props.workspaceId,
      contactId: props.contactId,
      keyword: id ?? field.name,
      value: props.values[field.name] as string,
      contactInboxId: props.contactInboxId,
    })
  }
  return ids
}

/** Rounds a converging writer runs; its last round only verifies. */
const SYNC_MAX_ROUNDS = 4

/**
 * s237: `invoice_last_status` always describes the invoice `invoice_last_id`
 * names, read from its ROW, never from a status a caller decided on earlier
 * (the live run had #26's payment write `paid` while the latest, #28, was
 * open; a blind probe then showed every pass-the-status-in shape can land
 * late). Every mark ends here: read the named invoice's row, write its status
 * when the field differs, read again, until they agree. No lock: each row
 * change (create, webhook CAS, refund) is followed by a mark that ends in this
 * loop, so the LAST writer to finish leaves the current truth.
 * `payment_failed` is not a row status: it stands only while
 * `invoice_failed_id` names the latest invoice and its row is still open.
 */
async function syncLatestStatus(props: {
  workspaceId: string
  contactId: string
  contactInboxId?: string
}): Promise<void> {
  const fields = [
    INVOICE_LAST_ID_FIELD,
    INVOICE_LAST_STATUS_FIELD,
    INVOICE_FAILED_ID_FIELD,
  ].map((name) => ({ name, type: "shortText" as const }))
  const { idMap } = await customFieldService.resolveByNameAndType({
    workspaceId: props.workspaceId,
    fields,
  })
  const [lastIdField, statusField, failedIdField] = fields.map((f) =>
    idMap.get(customFieldResolutionKey(f)),
  )
  if (!(lastIdField && statusField && failedIdField)) {
    return
  }
  const read = (customFieldId: string) =>
    contactCustomFieldService.findValue({
      contactId: props.contactId,
      customFieldId,
    })
  for (let round = 0; round <= SYNC_MAX_ROUNDS; round++) {
    const lastId = await read(lastIdField)
    if (!lastId) {
      return
    }
    const [row] = await db
      .select({ status: invoiceModel.status })
      .from(invoiceModel)
      .where(
        and(
          eq(invoiceModel.id, lastId),
          eq(invoiceModel.contactId, props.contactId),
        ),
      )
      .limit(1)
    if (!row) {
      return
    }
    const current = await read(statusField)
    if (current === row.status) {
      return
    }
    if (
      current === PAYMENT_FAILED &&
      row.status === "open" &&
      (await read(failedIdField)) === lastId
    ) {
      return
    }
    if (round === SYNC_MAX_ROUNDS) {
      break
    }
    await setFields({
      ...props,
      values: { [INVOICE_LAST_STATUS_FIELD]: row.status },
    })
  }
  logger.warn(
    { contactId: props.contactId },
    "invoice_last_status did not settle; a concurrent mark converges it",
  )
}

const PAYMENT_FAILED = "payment_failed"

/**
 * The create-time write: which invoice is the contact's latest, and its link;
 * then the status converges from the row (a webhook may already have moved it,
 * s212b review).
 */
export async function markInvoiceCreated(props: {
  invoice: InvoiceModel
  contactInboxId?: string
}): Promise<void> {
  const { invoice } = props
  const base = {
    workspaceId: invoice.workspaceId,
    contactId: invoice.contactId,
    contactInboxId: props.contactInboxId,
  }
  await setFields({
    ...base,
    values: {
      [INVOICE_LINK_FIELD]: invoice.hostedUrl ?? "",
      [INVOICE_PDF_LINK_FIELD]: invoicePdfUrl(invoice) ?? "",
      [INVOICE_LAST_ID_FIELD]: invoice.id,
    },
  })
  await syncLatestStatus(base)
}

/**
 * s235: a refund rolled the invoice back (paid -> partiallyPaid, partiallyPaid
 * -> open, -> refunded). Only `invoice_last_status` moves: the paid / deposit
 * ids and tags record that a payment once landed and never re-fire. Idempotent,
 * so a redelivery may always run it again.
 */
export async function markInvoiceStatusOnContact(props: {
  invoice: InvoiceModel
}): Promise<void> {
  await syncLatestStatus({
    workspaceId: props.invoice.workspaceId,
    contactId: props.invoice.contactId,
  })
}

/**
 * A provider status change (webhook): on paid the id + tag (any invoice, so a
 * per-invoice wait wakes); the status field converges to the latest invoice.
 * A failed payment of the latest, still-open invoice writes `payment_failed`.
 */
export async function markInvoiceOnContact(props: {
  invoice: InvoiceModel
  status: string
}): Promise<void> {
  const { invoice } = props
  const base = {
    workspaceId: invoice.workspaceId,
    contactId: invoice.contactId,
  }
  const values: Record<string, string> = {}
  if (props.status === "paid") {
    values[INVOICE_PAID_ID_FIELD] = invoice.id
  }
  if (props.status === "partiallyPaid") {
    values[INVOICE_DEPOSIT_PAID_ID_FIELD] = invoice.id
  }
  if (Object.keys(values).length > 0) {
    await setFields({ ...base, values })
  }
  if (props.status === PAYMENT_FAILED) {
    await markPaymentFailed(invoice)
  }
  await syncLatestStatus(base)
  if (props.status === "paid") {
    await tagService.attachByNamesToContacts({
      workspaceId: invoice.workspaceId,
      contactIds: [invoice.contactId],
      names: [INVOICE_PAID_TAG],
      emitFor: "all",
    })
  }
  if (props.status === "partiallyPaid") {
    await tagService.attachByNamesToContacts({
      workspaceId: invoice.workspaceId,
      contactIds: [invoice.contactId],
      names: [INVOICE_DEPOSIT_PAID_TAG],
      emitFor: "all",
    })
  }
}

/**
 * A failed payment of the contact's LATEST, still-open invoice: record its id
 * in `invoice_failed_id`, then write `payment_failed`. An older invoice's
 * failure writes nothing (it must not clear the latest's own failure, s237
 * probe T9). A create racing these writes is corrected by the caller's sync:
 * `invoice_failed_id` then names an invoice that is no longer the latest.
 */
async function markPaymentFailed(invoice: InvoiceModel): Promise<void> {
  const field = { name: INVOICE_LAST_ID_FIELD, type: "shortText" as const }
  const { idMap } = await customFieldService.resolveByNameAndType({
    workspaceId: invoice.workspaceId,
    fields: [field],
  })
  const lastIdField = idMap.get(customFieldResolutionKey(field))
  if (!lastIdField) {
    return
  }
  const lastId = await contactCustomFieldService.findValue({
    contactId: invoice.contactId,
    customFieldId: lastIdField,
  })
  const [row] = await db
    .select({ status: invoiceModel.status })
    .from(invoiceModel)
    .where(eq(invoiceModel.id, invoice.id))
    .limit(1)
  if (lastId !== invoice.id || row?.status !== "open") {
    return
  }
  const base = {
    workspaceId: invoice.workspaceId,
    contactId: invoice.contactId,
  }
  await setFields({
    ...base,
    values: { [INVOICE_FAILED_ID_FIELD]: invoice.id },
  })
  await setFields({
    ...base,
    values: { [INVOICE_LAST_STATUS_FIELD]: PAYMENT_FAILED },
  })
}
