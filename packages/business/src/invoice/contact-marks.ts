import type { InvoiceModel } from "@chatbotx.io/database/types"
import { customFieldResolutionKey } from "@chatbotx.io/utils/custom-field"
import { contactCustomFieldService } from "../contact-custom-field/service"
import { customFieldService } from "../custom-field/service"
import { tagService } from "../tag/service"

/**
 * What an invoice writes onto its contact so a flow can branch or WAIT on it:
 * - `invoice_link` / `invoice_last_id`: the latest invoice (written at create)
 * - `invoice_last_status`: its latest status (`open`, `paid`, `payment_failed`, ...)
 * - `invoice_paid_id`: the id of the invoice that was just PAID. A flow waits
 *   per invoice with `customFieldChanged` on it and matchValue
 *   `{{raw:invoice_last_id}}` (the wait captures the id at wait start).
 * - tag `invoice-paid` on every payment (emitFor "all": a second paid invoice
 *   must still wake a tagApplied wait).
 */
export const INVOICE_LINK_FIELD = "invoice_link"
export const INVOICE_LAST_ID_FIELD = "invoice_last_id"
export const INVOICE_LAST_STATUS_FIELD = "invoice_last_status"
export const INVOICE_PAID_ID_FIELD = "invoice_paid_id"
export const INVOICE_PAID_TAG = "invoice-paid"

async function setFields(props: {
  workspaceId: string
  contactId: string
  contactInboxId?: string
  values: Record<string, string>
}): Promise<void> {
  const fields = Object.keys(props.values).map((name) => ({
    name,
    type: "shortText" as const,
  }))
  const { idMap } = await customFieldService.resolveByNameAndType({
    workspaceId: props.workspaceId,
    fields,
  })
  for (const field of fields) {
    await contactCustomFieldService.setValueByKey({
      workspaceId: props.workspaceId,
      contactId: props.contactId,
      keyword: idMap.get(customFieldResolutionKey(field)) ?? field.name,
      value: props.values[field.name] as string,
      contactInboxId: props.contactInboxId,
    })
  }
}

/** The create-time write: which invoice is the contact's latest, and its link. */
export async function markInvoiceCreated(props: {
  invoice: InvoiceModel
  contactInboxId?: string
}): Promise<void> {
  const { invoice } = props
  await setFields({
    workspaceId: invoice.workspaceId,
    contactId: invoice.contactId,
    contactInboxId: props.contactInboxId,
    values: {
      [INVOICE_LINK_FIELD]: invoice.hostedUrl ?? "",
      [INVOICE_LAST_ID_FIELD]: invoice.id,
      [INVOICE_LAST_STATUS_FIELD]: invoice.status,
    },
  })
}

/** A provider status change (webhook): status field, and on paid the id + tag. */
export async function markInvoiceOnContact(props: {
  invoice: InvoiceModel
  status: string
}): Promise<void> {
  const { invoice } = props
  const values: Record<string, string> = {
    [INVOICE_LAST_STATUS_FIELD]: props.status,
  }
  if (props.status === "paid") {
    values[INVOICE_PAID_ID_FIELD] = invoice.id
  }
  await setFields({
    workspaceId: invoice.workspaceId,
    contactId: invoice.contactId,
    values,
  })
  if (props.status === "paid") {
    await tagService.attachByNamesToContacts({
      workspaceId: invoice.workspaceId,
      contactIds: [invoice.contactId],
      names: [INVOICE_PAID_TAG],
      emitFor: "all",
    })
  }
}
