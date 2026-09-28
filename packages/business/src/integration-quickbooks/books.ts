import { and, db, eq } from "@chatbotx.io/database/client"
import {
  currencyExponent,
  decimalStringToMinor,
} from "@chatbotx.io/database/partials"
import {
  contactModel,
  quickbooksCustomerModel,
} from "@chatbotx.io/database/schema"
import type {
  InvoiceLineItemModel,
  InvoiceModel,
} from "@chatbotx.io/database/types"
import type { QuickbooksConnection } from "./connection"
import {
  createQuickbooksCustomer,
  createQuickbooksInvoice,
  findQuickbooksCustomerByEmail,
  findQuickbooksInvoiceByMarker,
  type QuickbooksCall,
  type QuickbooksInvoice,
  quickbooksHubMarker,
} from "./entities"

/**
 * A QuickBooks refusal the caller should surface, not retry: the invoice's
 * own content (currency, total, contact) does not fit the company.
 */
export class QuickbooksBooksError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "QuickbooksBooksError"
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** QBO DisplayNames refuse colons, tabs and newlines. */
const DISPLAY_NAME_FORBIDDEN = /[:\t\r\n]+/g

/** A contact's QBO DisplayName: unique by construction (it names the contact). */
export const quickbooksDisplayName = (
  contact: {
    fullName: string | null
    email: string | null
    phoneNumber: string | null
  },
  contactId: string,
): string => {
  const name =
    (contact.fullName || contact.email || contact.phoneNumber || "Contact")
      .replace(DISPLAY_NAME_FORBIDDEN, " ")
      .trim()
      .slice(0, 100) || "Contact"
  return `${name} (hub ${contactId})`
}

/** The invoice currency must be the company's, unless it has multicurrency. */
export function assertQuickbooksCurrency(
  connection: Pick<QuickbooksConnection, "homeCurrency" | "multicurrency">,
  currency: string,
): void {
  if (currency !== connection.homeCurrency && !connection.multicurrency) {
    throw new QuickbooksBooksError(
      `The QuickBooks company books in ${connection.homeCurrency}, not ${currency} (turn on multicurrency in QuickBooks)`,
    )
  }
}

/**
 * The QBO customer of a hub contact in this company: the stored map, else a
 * customer with the contact's email (exactly one), else a new one. The map
 * row is written once (a racing writer's row wins and is returned).
 */
export async function ensureQuickbooksCustomer(props: {
  call: QuickbooksCall
  connection: QuickbooksConnection
  invoice: Pick<InvoiceModel, "workspaceId" | "contactId" | "currency">
}): Promise<{ customerId: string; email: string | null }> {
  const { connection, invoice } = props
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
  if (!contact) {
    throw new QuickbooksBooksError("Contact not found")
  }
  const email =
    contact.email && EMAIL.test(contact.email) ? contact.email : null
  const mapped = await db.query.quickbooksCustomerModel.findFirst({
    where: {
      integrationId: connection.integrationId,
      contactId: invoice.contactId,
    },
  })
  if (mapped) {
    return { customerId: mapped.customerId, email }
  }
  const customerId =
    (email ? await findQuickbooksCustomerByEmail(props.call, email) : null) ??
    (await createQuickbooksCustomer(props.call, {
      body: {
        DisplayName: quickbooksDisplayName(contact, invoice.contactId),
        ...(email ? { PrimaryEmailAddr: { Address: email } } : {}),
        ...(contact.phoneNumber
          ? {
              PrimaryPhone: {
                FreeFormNumber: contact.phoneNumber.slice(0, 30),
              },
            }
          : {}),
        ...(connection.multicurrency
          ? { CurrencyRef: { value: invoice.currency } }
          : {}),
      },
      // A minute bucket: racing creates dedup, a later retry is not stuck on
      // a cached failure (DisplayName uniqueness adopts a lost create).
      requestId: `hub-cust-${invoice.contactId}-${Math.floor(Date.now() / 60_000).toString(36)}`,
    }))
  await db
    .insert(quickbooksCustomerModel)
    .values({
      workspaceId: invoice.workspaceId,
      integrationId: connection.integrationId,
      contactId: invoice.contactId,
      customerId,
    })
    .onConflictDoNothing()
  const stored = await db.query.quickbooksCustomerModel.findFirst({
    where: {
      integrationId: connection.integrationId,
      contactId: invoice.contactId,
    },
  })
  return { customerId: stored?.customerId ?? customerId, email }
}

/** A QBO amount (a JSON number) in minor units of `currency`. */
export const quickbooksAmountToMinor = (
  amount: number | null,
  currency: string,
): bigint | null =>
  amount === null
    ? null
    : BigInt(Math.round(amount * 10 ** currencyExponent(currency)))

/** A stored numeric(14,2) string as the JSON number QBO takes. */
const amount = (value: string) => Number(value)

const dateOnly = (value: Date) => value.toISOString().slice(0, 10)

/**
 * The QBO Invoice body of a hub invoice. `collect` (the quickbooks method)
 * turns on online card/ACH payment and sets BillEmail, which QBO needs to
 * produce an InvoiceLink; a mirror copy (paid elsewhere) never offers one.
 * No DocNumber: a company without custom numbers must number it itself.
 */
export function quickbooksInvoiceBody(props: {
  invoice: InvoiceModel
  lines: InvoiceLineItemModel[]
  connection: QuickbooksConnection
  customerId: string
  collect: { email: string } | null
}): Record<string, unknown> {
  const { invoice, connection } = props
  return {
    CustomerRef: { value: props.customerId },
    Line: props.lines.map((line) => ({
      Amount: amount(line.amount),
      DetailType: "SalesItemLineDetail",
      Description: line.description.slice(0, 4000),
      SalesItemLineDetail: {
        ItemRef: { value: connection.itemId },
        Qty: line.quantity,
        UnitPrice: amount(line.unitAmount),
      },
    })),
    PrivateNote: `Hub invoice #${invoice.number} ${quickbooksHubMarker(invoice.id)}`,
    TxnDate: dateOnly(invoice.createdAt),
    ...(invoice.dueAt ? { DueDate: dateOnly(invoice.dueAt) } : {}),
    ...(invoice.memo
      ? { CustomerMemo: { value: invoice.memo.slice(0, 1000) } }
      : {}),
    ...(connection.multicurrency
      ? { CurrencyRef: { value: invoice.currency } }
      : {}),
    ...(props.collect
      ? {
          BillEmail: { Address: props.collect.email },
          AllowOnlineCreditCardPayment: true,
          AllowOnlineACHPayment: true,
        }
      : {
          AllowOnlineCreditCardPayment: false,
          AllowOnlineACHPayment: false,
        }),
  }
}

/**
 * The QBO invoice of a hub invoice: adopted when one already carries the hub
 * marker (a lost answer), else created. `attemptKey` joins the request id:
 * racing creates of one attempt dedup at Intuit, a retry after a recorded
 * failure is not stuck on a cached error. The total must match the hub's to
 * the minor unit (QBO adds sales tax on its own); a mismatch is a
 * QuickbooksBooksError and the caller decides what to do with the invoice.
 */
export async function upsertQuickbooksInvoice(props: {
  call: QuickbooksCall
  connection: QuickbooksConnection
  invoice: InvoiceModel
  lines: InvoiceLineItemModel[]
  customerId: string
  collect: { email: string } | null
  attemptKey: string
}): Promise<{
  qbo: QuickbooksInvoice
  adopted: boolean
  totalMatches: boolean
}> {
  const { invoice } = props
  const found = await findQuickbooksInvoiceByMarker(props.call, {
    customerId: props.customerId,
    marker: quickbooksHubMarker(invoice.id),
    since: invoice.createdAt,
  })
  // A copy an earlier attempt voided (a total mismatch) is not this invoice.
  const adopted = found?.privateNote?.startsWith("Voided") ? null : found
  const qbo =
    adopted ??
    (await createQuickbooksInvoice(props.call, {
      body: quickbooksInvoiceBody(props),
      requestId: `hub-inv-${invoice.id}-${props.attemptKey}`.slice(0, 50),
    }))
  const expected = decimalStringToMinor(invoice.total, invoice.currency)
  return {
    qbo,
    adopted: !!adopted,
    totalMatches:
      quickbooksAmountToMinor(qbo.totalAmt, invoice.currency) === expected,
  }
}

/**
 * A live QBO copy of a hub invoice that no row records (an attempt that
 * created it and died, or whose answer was lost), found by the hub marker.
 * Only a contact this company already has a customer for can have one.
 */
export async function findUnrecordedQuickbooksInvoice(props: {
  call: QuickbooksCall
  integrationId: string
  invoice: Pick<InvoiceModel, "id" | "contactId" | "createdAt">
}): Promise<QuickbooksInvoice | null> {
  const customer = await db.query.quickbooksCustomerModel.findFirst({
    where: {
      integrationId: props.integrationId,
      contactId: props.invoice.contactId,
    },
  })
  return customer
    ? await findQuickbooksInvoiceByMarker(props.call, {
        customerId: customer.customerId,
        marker: quickbooksHubMarker(props.invoice.id),
        since: props.invoice.createdAt,
      })
    : null
}
