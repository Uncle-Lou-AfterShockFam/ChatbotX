import { and, db, eq } from "@chatbotx.io/database/client"
import {
  INVOICE_DOCUMENT_REF_PREFIX,
  type InvoiceDocumentKind,
  invoiceDocumentKind,
} from "@chatbotx.io/database/partials"
import { contactModel, workspaceModel } from "@chatbotx.io/database/schema"
import type {
  ContactDocumentModel,
  InvoiceLineItemModel,
  InvoiceModel,
} from "@chatbotx.io/database/types"
import { uploader } from "@chatbotx.io/filesystem"
import { formatWithFallback } from "@chatbotx.io/utils"
import { escapeHtml, wrapDocumentHtml } from "../documents/html"
import { documentService } from "../documents/service"
import { logger } from "../logger"
import { isInvoicePayToken } from "./checkout-provider"

/**
 * The hub's own PDF of a stripeCheckout invoice (s210b, PR 2b): an INVOICE
 * while it is open, a RECEIPT once it is paid. Each is rendered once
 * (Gotenberg) and stored as a ContactDocument (`invoice:<id>:<kind>`), so the
 * contact and workspace purges cover it; `/pay/<token>/pdf` serves it. A
 * stripeInvoice keeps Stripe's own PDF (`Invoice.pdfUrl`).
 */
export const invoiceDocumentRef = (
  invoiceId: string,
  kind: InvoiceDocumentKind,
): string => `${INVOICE_DOCUMENT_REF_PREFIX}${invoiceId}:${kind}`

const invoiceDocumentTitle = (
  number: number,
  kind: InvoiceDocumentKind,
): string => `${kind === "receipt" ? "Receipt" : "Invoice"} #${number}`

/** A stored numeric(14,2) string in `currency`, e.g. "$1,250.50" / "¥1,250". */
export const formatInvoiceMoney = (value: string, currency: string): string => {
  try {
    // The decimal string, not a float: Intl formats it exactly.
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(value as Intl.StringNumericLiteral)
  } catch {
    return `${value} ${currency}`
  }
}

const INVOICE_CSS = `
.inv-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8mm; }
.inv-from { font-size: 13pt; font-weight: bold; }
.inv-meta { text-align: right; font-size: 10.5pt; color: #333; }
.inv-badge { display: inline-block; border: 2px solid #15803d; color: #15803d; font-weight: bold; padding: 1mm 3mm; border-radius: 2mm; letter-spacing: 1px; margin-bottom: 2mm; }
.inv-to { margin-bottom: 6mm; } .inv-label { font-size: 9.5pt; color: #555; text-transform: uppercase; letter-spacing: .5px; }
.inv-lines th { background: #f2f2f2; text-align: left; } .inv-num { text-align: right; white-space: nowrap; }
.inv-lines td { vertical-align: top; } .inv-total td { font-weight: bold; }
.inv-memo { margin-top: 6mm; white-space: pre-wrap; }
`

const text = (value: string | null | undefined): string =>
  escapeHtml(value ?? "").replace(/\r?\n/g, "<br>")

/**
 * The invoice / receipt page (pure). Every value is escaped and the signing
 * pass is off, so a line reading `{{signature, r1}}` stays plain text.
 */
export function renderInvoiceHtml(props: {
  kind: InvoiceDocumentKind
  invoice: Pick<
    InvoiceModel,
    "number" | "currency" | "total" | "memo" | "dueAt" | "paidAt" | "createdAt"
  >
  lines: Pick<
    InvoiceLineItemModel,
    "position" | "description" | "quantity" | "unitAmount" | "amount"
  >[]
  contact: {
    fullName: string | null
    email: string | null
    phoneNumber: string | null
  }
  workspace: { name: string; timezone: string | null }
}): string {
  const { kind, invoice, contact, workspace } = props
  const money = (value: string) => formatInvoiceMoney(value, invoice.currency)
  const title = invoiceDocumentTitle(invoice.number, kind)
  // zone: workspace (the business's own calendar)
  const issued = formatWithFallback(
    invoice.createdAt,
    workspace.timezone,
    "MMMM d, yyyy",
  )
  const meta = [`Issued ${issued}`]
  if (kind === "receipt") {
    if (invoice.paidAt) {
      // zone: workspace (the business's own calendar)
      const paid = formatWithFallback(
        invoice.paidAt,
        workspace.timezone,
        "MMMM d, yyyy h:mm a zzz",
      )
      meta.push(`Paid ${paid}`)
    }
  } else if (invoice.dueAt) {
    // zone: UTC (a due date is a UTC day, the house convention)
    meta.push(`Due ${formatWithFallback(invoice.dueAt, "UTC", "MMMM d, yyyy")}`)
  }
  const billTo = [contact.fullName, contact.email, contact.phoneNumber]
    .filter((v): v is string => !!v?.trim())
    .map(text)
    .join("<br>")
  const rows = [...props.lines]
    .sort((a, b) => a.position - b.position)
    .map(
      (line) =>
        `<tr><td>${text(line.description)}</td><td class="inv-num">${line.quantity}</td><td class="inv-num">${escapeHtml(money(line.unitAmount))}</td><td class="inv-num">${escapeHtml(money(line.amount))}</td></tr>`,
    )
    .join("")
  const body = `<div class="inv-head"><div><div class="inv-from">${text(workspace.name)}</div></div><div class="inv-meta">${kind === "receipt" ? '<div class="inv-badge">PAID</div><br>' : ""}<h1>${escapeHtml(title)}</h1>${meta.map(text).join("<br>")}</div></div>
${billTo ? `<div class="inv-to"><div class="inv-label">${kind === "receipt" ? "Received from" : "Bill to"}</div>${billTo}</div>` : ""}
<table class="inv-lines"><thead><tr><th>Description</th><th class="inv-num">Qty</th><th class="inv-num">Unit price</th><th class="inv-num">Amount</th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr class="inv-total"><td colspan="3" class="inv-num">${kind === "receipt" ? "Total paid" : "Total due"} (${escapeHtml(invoice.currency)})</td><td class="inv-num">${escapeHtml(money(invoice.total))}</td></tr></tfoot></table>
${invoice.memo?.trim() ? `<div class="inv-memo">${escapeHtml(invoice.memo)}</div>` : ""}`
  return wrapDocumentHtml(title, body, {
    signing: false,
    extraCss: INVOICE_CSS,
  })
}

type InvoiceWithLines = InvoiceModel & { lineItems: InvoiceLineItemModel[] }

/**
 * The stored `kind` document of `invoice`, rendering it on first use. Idempotent
 * per (contact, ref); concurrent first uses store ONE row (documentService).
 * Throws when the render or the store fails (the caller decides what that means).
 */
export async function ensureInvoiceDocument(props: {
  invoice: InvoiceWithLines
  kind: InvoiceDocumentKind
  now?: Date
}): Promise<ContactDocumentModel> {
  const { invoice, kind } = props
  const now = props.now ?? new Date()
  const ref = invoiceDocumentRef(invoice.id, kind)
  const existing = await documentService.findByRef({
    contactId: invoice.contactId,
    ref,
    tx: db,
  })
  if (existing) {
    return existing
  }
  const [contact] = await db
    .select({
      fullName: contactModel.fullName,
      email: contactModel.email,
      phoneNumber: contactModel.phoneNumber,
    })
    .from(contactModel)
    .where(
      and(
        eq(contactModel.id, invoice.contactId),
        eq(contactModel.workspaceId, invoice.workspaceId),
      ),
    )
    .limit(1)
  const [workspace] = await db
    .select({ name: workspaceModel.name, timezone: workspaceModel.timezone })
    .from(workspaceModel)
    .where(eq(workspaceModel.id, invoice.workspaceId))
    .limit(1)
  if (!(contact && workspace)) {
    throw new Error(`invoice ${invoice.id}: contact or workspace is gone`)
  }
  await documentService.assertGenerateBudget({
    workspaceId: invoice.workspaceId,
    now,
    tx: db,
    kind: "invoice",
  })
  const { document } = await documentService.storeRenderedPdf({
    workspaceId: invoice.workspaceId,
    contactId: invoice.contactId,
    templateId: null,
    title: invoiceDocumentTitle(invoice.number, kind),
    ref,
    html: renderInvoiceHtml({
      kind,
      invoice,
      lines: invoice.lineItems,
      contact,
      workspace,
    }),
    field: "invoice",
    now,
    tx: db,
  })
  return document
}

const loadWithLines = async (where: { payToken: string } | { id: string }) =>
  await db.query.invoiceModel.findFirst({
    where,
    with: { lineItems: { orderBy: { position: "asc" } } },
  })

export type InvoicePdfVisit =
  | { kind: "pdf"; pdf: Buffer; title: string }
  | { kind: "notFound" }
  /** The workspace is frozen (scheduled for deletion). */
  | { kind: "frozen" }

/**
 * `/pay/<token>/pdf`: the invoice's current document (open -> invoice, paid ->
 * receipt). Never touches Stripe. Throws when the render or storage fails.
 */
export async function visitInvoicePdf(
  token: string,
  options: { canServe: (workspaceId: string) => Promise<boolean> },
): Promise<InvoicePdfVisit> {
  if (!isInvoicePayToken(token)) {
    return { kind: "notFound" }
  }
  const invoice = await loadWithLines({ payToken: token })
  if (invoice?.method !== "stripeCheckout") {
    return { kind: "notFound" }
  }
  const kind = invoiceDocumentKind(invoice.status)
  if (!kind) {
    return { kind: "notFound" }
  }
  if (!(await options.canServe(invoice.workspaceId))) {
    return { kind: "frozen" }
  }
  const document = await ensureInvoiceDocument({ invoice, kind })
  if (!document.path) {
    throw new Error(`invoice document ${document.id} has no file`)
  }
  return {
    kind: "pdf",
    pdf: await uploader.getObject(document.path),
    title: document.title,
  }
}

/**
 * Best effort, after a checkout payment is marked: store the receipt now so
 * the first `/pay/<token>/pdf` is instant. Never throws (the visit renders
 * it on demand when this fails).
 */
export async function prerenderInvoiceReceipt(
  invoiceId: string,
): Promise<void> {
  try {
    const invoice = await loadWithLines({ id: invoiceId })
    if (invoice?.method !== "stripeCheckout" || invoice.status !== "paid") {
      return
    }
    await ensureInvoiceDocument({ invoice, kind: "receipt" })
  } catch (error) {
    logger.warn(
      { err: error, invoiceId },
      "invoice: receipt pre-render failed; /pay/<token>/pdf renders it on demand",
    )
  }
}
