import { and, db, eq } from "@chatbotx.io/database/client"
import {
  decimalStringToMinor,
  hubDocumentMethods,
  INVOICE_DOCUMENT_REF_PREFIX,
  type InvoiceDocumentKind,
  invoiceDocumentKind,
  minorToDecimalString,
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
import { amountDueMinor } from "./payments"

/**
 * The hub's own PDF of a stripeCheckout (s210b, PR 2b) or woocommerce
 * (s213b) invoice: an INVOICE
 * while it is open, a RECEIPT once it is paid. Each is rendered once
 * (Gotenberg) and stored as a ContactDocument (`invoice:<id>:<kind>`), so the
 * contact and workspace purges cover it; `/pay/<token>/pdf` serves it. A
 * stripeInvoice keeps Stripe's own PDF (`Invoice.pdfUrl`).
 */
export const invoiceDocumentRef = (
  invoiceId: string,
  kind: InvoiceDocumentKind,
  variant?: string,
): string =>
  `${INVOICE_DOCUMENT_REF_PREFIX}${invoiceId}:${kind}${variant ? `:${variant}` : ""}`

/**
 * s235: a refund can leave a partly paid invoice holding something other than
 * its deposit (the deposit refunded, the balance kept). Its deposit receipt
 * then states a different amount, so it is a different document: keyed by the
 * amount held. The usual case (the deposit held) keeps the plain ref.
 */
const invoiceDocumentVariant = (
  invoice: Pick<InvoiceModel, "amountPaid" | "depositAmount" | "currency">,
  kind: InvoiceDocumentKind,
): string | undefined => {
  if (kind !== "depositReceipt" || !invoice.depositAmount) {
    return
  }
  const held = decimalStringToMinor(invoice.amountPaid, invoice.currency)
  return held === decimalStringToMinor(invoice.depositAmount, invoice.currency)
    ? undefined
    : `held-${held}`
}

const invoiceDocumentTitle = (
  number: number,
  kind: InvoiceDocumentKind,
): string =>
  `${{ invoice: "Invoice", depositReceipt: "Deposit receipt", receipt: "Receipt" }[kind]} #${number}`

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

/** Minor units of `currency`, formatted like `formatInvoiceMoney` (s216b pay page). */
export const formatInvoiceMinor = (minor: bigint, currency: string): string =>
  formatInvoiceMoney(minorToDecimalString(minor, currency), currency)

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

/** The stamp above the title: none on an open invoice. */
const INVOICE_BADGES: Record<InvoiceDocumentKind, string> = {
  invoice: "",
  depositReceipt: '<div class="inv-badge">DEPOSIT PAID</div><br>',
  receipt: '<div class="inv-badge">PAID</div><br>',
}

/** s235: a partly paid invoice holding something other than its deposit. */
const PART_PAID_BADGE = '<div class="inv-badge">PARTLY PAID</div><br>'

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
    | "number"
    | "currency"
    | "total"
    | "memo"
    | "dueAt"
    | "paidAt"
    | "createdAt"
    | "depositAmount"
    | "amountPaid"
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
  const paidSoFar = invoice.amountPaid ?? "0"
  // s216b: an open invoice names its deposit option; a deposit receipt
  // shows what was paid and what is still due.
  const footer =
    kind === "depositReceipt"
      ? [
          ["Invoice total", money(invoice.total)],
          // s235: after a refunded deposit the amount held is not the deposit.
          [
            invoiceDocumentVariant(invoice, kind)
              ? "Amount paid"
              : "Deposit paid",
            money(paidSoFar),
          ],
          [
            "Balance due",
            money(
              minorToDecimalString(
                amountDueMinor({ ...invoice, amountPaid: paidSoFar }),
                invoice.currency,
              ),
            ),
          ],
        ]
      : [
          [
            kind === "receipt" ? "Total paid" : "Total due",
            money(invoice.total),
          ],
          ...(kind === "invoice" && invoice.depositAmount
            ? [["Deposit accepted", money(invoice.depositAmount)]]
            : []),
        ]
  const footerRows = footer
    .map(
      ([label, value], index) =>
        `<tr${index === footer.length - 1 || kind !== "depositReceipt" ? ' class="inv-total"' : ""}><td colspan="3" class="inv-num">${escapeHtml(label as string)} (${escapeHtml(invoice.currency)})</td><td class="inv-num">${escapeHtml(value as string)}</td></tr>`,
    )
    .join("")
  const rows = [...props.lines]
    .sort((a, b) => a.position - b.position)
    .map(
      (line) =>
        `<tr><td>${text(line.description)}</td><td class="inv-num">${line.quantity}</td><td class="inv-num">${escapeHtml(money(line.unitAmount))}</td><td class="inv-num">${escapeHtml(money(line.amount))}</td></tr>`,
    )
    .join("")
  const body = `<div class="inv-head"><div><div class="inv-from">${text(workspace.name)}</div></div><div class="inv-meta">${kind === "depositReceipt" && invoiceDocumentVariant(invoice, kind) ? PART_PAID_BADGE : INVOICE_BADGES[kind]}<h1>${escapeHtml(title)}</h1>${meta.map(text).join("<br>")}</div></div>
${billTo ? `<div class="inv-to"><div class="inv-label">${kind === "invoice" ? "Bill to" : "Received from"}</div>${billTo}</div>` : ""}
<table class="inv-lines"><thead><tr><th>Description</th><th class="inv-num">Qty</th><th class="inv-num">Unit price</th><th class="inv-num">Amount</th></tr></thead><tbody>${rows}</tbody>
<tfoot>${footerRows}</tfoot></table>
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
  const ref = invoiceDocumentRef(
    invoice.id,
    kind,
    invoiceDocumentVariant(invoice, kind),
  )
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
  if (!(invoice && hubDocumentMethods.includes(invoice.method))) {
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
 * Best effort, after a checkout or WooCommerce payment is marked: store the receipt now so
 * the first `/pay/<token>/pdf` is instant. Never throws (the visit renders
 * it on demand when this fails).
 */
export async function prerenderInvoiceReceipt(
  invoiceId: string,
): Promise<void> {
  try {
    const invoice = await loadWithLines({ id: invoiceId })
    if (
      !(
        invoice &&
        hubDocumentMethods.includes(invoice.method) &&
        (invoice.status === "paid" || invoice.status === "partiallyPaid")
      )
    ) {
      return
    }
    await ensureInvoiceDocument({
      invoice,
      kind: invoice.status === "paid" ? "receipt" : "depositReceipt",
    })
  } catch (error) {
    logger.warn(
      { err: error, invoiceId },
      "invoice: receipt pre-render failed; /pay/<token>/pdf renders it on demand",
    )
  }
}
