import { db, eq } from "@chatbotx.io/database/client"
import { invoicePdfUrl } from "@chatbotx.io/database/partials"
import { invoiceModel } from "@chatbotx.io/database/schema"
import type { InvoiceModel } from "@chatbotx.io/database/types"
import { customFieldResolutionKey } from "@chatbotx.io/utils/custom-field"
import { contactCustomFieldService } from "../contact-custom-field/service"
import { customFieldService } from "../custom-field/service"
import { tagService } from "../tag/service"

/**
 * What an invoice writes onto its contact so a flow can branch or WAIT on it:
 * - `invoice_link` / `invoice_last_id`: the latest invoice (written when it
 *   opens, whichever path created it: flow step, Invoices page or /v1)
 * - `invoice_pdf_link`: its PDF (hub `/pay/<t>/pdf` for stripeCheckout and
 *   woocommerce, which serves the receipt once paid; Stripe's PDF for
 *   stripeInvoice; "" for a woocommerce invoice opened before s213b)
 * - `invoice_last_status`: its latest status (`open`, `paid`, `payment_failed`, ...)
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

/**
 * The create-time write: which invoice is the contact's latest, and its link.
 * A webhook may move the row (open -> paid) and mark the contact while this
 * write is in flight with the older status (s212b review), so the row is
 * re-read AFTER the write and a moved status is written again: the webhook
 * marks only after its status CAS, so the re-read sees any status it wrote.
 * Only while the contact still names THIS invoice: a newer invoice's marks
 * must never carry an older invoice's status. Known gap: `payment_failed` is
 * not a row status, so a later mark of the same invoice writes `open` over it
 * (as the flow step's re-mark of a reused invoice always did).
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
  const ids = await setFields({
    ...base,
    values: {
      [INVOICE_LINK_FIELD]: invoice.hostedUrl ?? "",
      [INVOICE_PDF_LINK_FIELD]: invoicePdfUrl(invoice) ?? "",
      [INVOICE_LAST_ID_FIELD]: invoice.id,
      [INVOICE_LAST_STATUS_FIELD]: invoice.status,
    },
  })
  const [current] = await db
    .select({ status: invoiceModel.status })
    .from(invoiceModel)
    .where(eq(invoiceModel.id, invoice.id))
    .limit(1)
  if (!current || current.status === invoice.status) {
    return
  }
  const lastIdField = ids.get(INVOICE_LAST_ID_FIELD)
  const lastId = lastIdField
    ? await contactCustomFieldService.findValue({
        contactId: invoice.contactId,
        customFieldId: lastIdField,
      })
    : null
  if (lastId === invoice.id) {
    await setFields({
      ...base,
      values: { [INVOICE_LAST_STATUS_FIELD]: current.status },
    })
  }
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
  if (!(await isContactsLatestInvoice(props.invoice))) {
    return
  }
  await setFields({
    workspaceId: props.invoice.workspaceId,
    contactId: props.invoice.contactId,
    values: { [INVOICE_LAST_STATUS_FIELD]: props.invoice.status },
  })
}

/**
 * s237: `invoice_last_status` describes the invoice `invoice_last_id` names.
 * A status change of an OLDER invoice (paid, refunded, failed while a newer
 * one is open) must not overwrite it: live, #26's payment wrote `paid` while
 * the contact's latest, #28, was open.
 */
async function isContactsLatestInvoice(
  invoice: InvoiceModel,
): Promise<boolean> {
  const field = { name: INVOICE_LAST_ID_FIELD, type: "shortText" as const }
  const { idMap } = await customFieldService.resolveByNameAndType({
    workspaceId: invoice.workspaceId,
    fields: [field],
  })
  const customFieldId = idMap.get(customFieldResolutionKey(field))
  if (!customFieldId) {
    return false
  }
  const lastId = await contactCustomFieldService.findValue({
    contactId: invoice.contactId,
    customFieldId,
  })
  return lastId === invoice.id
}

/**
 * A provider status change (webhook): on paid the id + tag (any invoice, so a
 * per-invoice wait wakes), and the status field while it is the latest.
 */
export async function markInvoiceOnContact(props: {
  invoice: InvoiceModel
  status: string
}): Promise<void> {
  const { invoice } = props
  const values: Record<string, string> = {}
  if (await isContactsLatestInvoice(invoice)) {
    values[INVOICE_LAST_STATUS_FIELD] = props.status
  }
  if (props.status === "paid") {
    values[INVOICE_PAID_ID_FIELD] = invoice.id
  }
  if (props.status === "partiallyPaid") {
    values[INVOICE_DEPOSIT_PAID_ID_FIELD] = invoice.id
  }
  if (Object.keys(values).length > 0) {
    await setFields({
      workspaceId: invoice.workspaceId,
      contactId: invoice.contactId,
      values,
    })
  }
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
