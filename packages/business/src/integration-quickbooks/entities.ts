import {
  QUICKBOOKS_STALE_OBJECT_CODE,
  QuickbooksApiError,
  type QuickbooksRequest,
  quickbooksQueryLiteral,
  quickbooksRequest,
} from "./client"

/**
 * The QuickBooks objects the hub reads and writes (s214b), as the few fields
 * it uses. Every reader tolerates missing fields (null) rather than trusting
 * the answer's shape.
 */
export type QuickbooksCall = (
  request: Omit<QuickbooksRequest, "environment" | "realmId" | "accessToken">,
) => Promise<Record<string, unknown>>

/** A call bound to one token, for the connect path (no stored connection yet). */
export const quickbooksCallWithToken =
  (props: {
    environment: QuickbooksRequest["environment"]
    realmId: string
    accessToken: string
  }): QuickbooksCall =>
  (request) =>
    quickbooksRequest({ ...request, ...props })

const ENTITY_ID = /^\d{1,20}$/

const obj = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null
const ref = (value: unknown): string | null => str(obj(value)?.value)

export type QuickbooksInvoice = {
  id: string
  syncToken: string
  totalAmt: number | null
  balance: number | null
  customerId: string | null
  privateNote: string | null
  invoiceLink: string | null
  currency: string | null
}

export function readQuickbooksInvoice(
  value: unknown,
): QuickbooksInvoice | null {
  const invoice = obj(value)
  const id = str(invoice?.Id)
  const syncToken = str(invoice?.SyncToken)
  if (!(invoice && id && syncToken)) {
    return null
  }
  return {
    id,
    syncToken,
    totalAmt: num(invoice.TotalAmt),
    balance: num(invoice.Balance),
    customerId: ref(invoice.CustomerRef),
    privateNote: str(invoice.PrivateNote),
    invoiceLink: str(invoice.InvoiceLink),
    currency: ref(invoice.CurrencyRef),
  }
}

export type QuickbooksPayment = {
  id: string
  totalAmt: number | null
  /** The invoices this payment pays (Line[].LinkedTxn of type Invoice). */
  invoiceIds: string[]
  privateNote: string | null
}

export function readQuickbooksPayment(
  value: unknown,
): QuickbooksPayment | null {
  const payment = obj(value)
  const id = str(payment?.Id)
  if (!(payment && id)) {
    return null
  }
  const invoiceIds = new Set<string>()
  const lines = Array.isArray(payment.Line) ? payment.Line.slice(0, 100) : []
  for (const line of lines) {
    const linked = obj(line)?.LinkedTxn
    for (const txn of Array.isArray(linked) ? linked.slice(0, 100) : []) {
      const t = obj(txn)
      const txnId = str(t?.TxnId)
      if (t?.TxnType === "Invoice" && txnId) {
        invoiceIds.add(txnId)
      }
    }
  }
  return {
    id,
    totalAmt: num(payment.TotalAmt),
    invoiceIds: [...invoiceIds],
    privateNote: str(payment.PrivateNote),
  }
}

/** QBO's "paid" reading of an invoice: a positive total with nothing owed. */
export const isQuickbooksInvoicePaid = (invoice: QuickbooksInvoice): boolean =>
  (invoice.totalAmt ?? 0) > 0 && invoice.balance === 0

async function queryRows(
  call: QuickbooksCall,
  entity: string,
  select: string,
): Promise<Record<string, unknown>[]> {
  const answer = await call({
    method: "GET",
    path: "query",
    query: { query: select },
  })
  const rows = obj(answer.QueryResponse)?.[entity]
  return Array.isArray(rows)
    ? rows.filter((row): row is Record<string, unknown> => !!obj(row))
    : []
}

export type QuickbooksCompany = {
  companyName: string | null
  homeCurrency: string
  multicurrency: boolean
}

/** Name, home currency and multicurrency switch of the connected company. */
export async function readQuickbooksCompany(
  call: QuickbooksCall,
  realmId: string,
): Promise<QuickbooksCompany> {
  const [info, prefs] = await Promise.all([
    call({ method: "GET", path: `companyinfo/${realmId}` }),
    call({ method: "GET", path: "preferences" }),
  ])
  const currencyPrefs = obj(obj(prefs.Preferences)?.CurrencyPrefs)
  return {
    companyName: str(obj(info.CompanyInfo)?.CompanyName),
    homeCurrency: (ref(currencyPrefs?.HomeCurrency) ?? "USD").toUpperCase(),
    multicurrency: currencyPrefs?.MultiCurrencyEnabled === true,
  }
}

export const QUICKBOOKS_HUB_ITEM_NAME = "Hub sales"

/**
 * The Service item hub lines are booked against: an existing "Hub sales"
 * item, else a new one on the company's first active Income account. Not
 * taxable: QBO must not add tax the hub did not bill (the totals are checked).
 */
export async function ensureQuickbooksHubItem(
  call: QuickbooksCall,
): Promise<string> {
  const existing = await queryRows(
    call,
    "Item",
    `select Id from Item where Name = ${quickbooksQueryLiteral(QUICKBOOKS_HUB_ITEM_NAME)}`,
  )
  const existingId = str(existing[0]?.Id)
  if (existingId) {
    return existingId
  }
  const income = await queryRows(
    call,
    "Account",
    "select Id from Account where AccountType = 'Income' and Active = true maxresults 1",
  )
  const incomeId = str(income[0]?.Id)
  if (!incomeId) {
    throw new Error("The QuickBooks company has no active Income account")
  }
  const answer = await call({
    method: "POST",
    path: "item",
    body: {
      Name: QUICKBOOKS_HUB_ITEM_NAME,
      Type: "Service",
      Taxable: false,
      IncomeAccountRef: { value: incomeId },
    },
  })
  const id = str(obj(answer.Item)?.Id)
  if (!id) {
    throw new Error("QuickBooks answered no item id")
  }
  return id
}

export async function getQuickbooksInvoice(
  call: QuickbooksCall,
  id: string,
): Promise<QuickbooksInvoice | null> {
  if (!ENTITY_ID.test(id)) {
    return null
  }
  const answer = await call({
    method: "GET",
    path: `invoice/${id}`,
    query: { include: "invoiceLink" },
  })
  return readQuickbooksInvoice(answer.Invoice)
}

export async function getQuickbooksPayment(
  call: QuickbooksCall,
  id: string,
): Promise<QuickbooksPayment | null> {
  if (!ENTITY_ID.test(id)) {
    return null
  }
  const answer = await call({ method: "GET", path: `payment/${id}` })
  return readQuickbooksPayment(answer.Payment)
}

/** The PrivateNote tag that names a QBO invoice's hub invoice. */
export const quickbooksHubMarker = (invoiceId: string) => `[hub:${invoiceId}]`

/**
 * The customer's invoices or payments created since `since`. Adoption reads
 * these for the hub marker: a create whose answer was lost is found, never
 * duplicated (a QBO void prepends "Voided" to the note, so callers match a
 * substring). 1000 or more is refused (fail closed) rather than guessed.
 */
async function recentForCustomer(
  call: QuickbooksCall,
  entity: "Invoice" | "Payment",
  props: { customerId: string; since: Date },
): Promise<Record<string, unknown>[]> {
  const since = new Date(props.since.getTime() - 60_000).toISOString()
  const rows = await queryRows(
    call,
    entity,
    `select * from ${entity} where CustomerRef = ${quickbooksQueryLiteral(props.customerId)} and MetaData.CreateTime >= ${quickbooksQueryLiteral(since)} maxresults 1000`,
  )
  if (rows.length >= 1000) {
    throw new Error(
      `Too many QuickBooks ${entity} rows to look for an unrecorded one`,
    )
  }
  return rows
}

export async function findQuickbooksInvoiceByMarker(
  call: QuickbooksCall,
  props: { customerId: string; marker: string; since: Date },
): Promise<QuickbooksInvoice | null> {
  for (const row of await recentForCustomer(call, "Invoice", props)) {
    const invoice = readQuickbooksInvoice(row)
    if (invoice?.privateNote?.includes(props.marker)) {
      return invoice
    }
  }
  return null
}

export async function findQuickbooksPaymentByMarker(
  call: QuickbooksCall,
  props: { customerId: string; marker: string; since: Date },
): Promise<QuickbooksPayment | null> {
  for (const row of await recentForCustomer(call, "Payment", props)) {
    const payment = readQuickbooksPayment(row)
    if (payment?.privateNote?.includes(props.marker)) {
      return payment
    }
  }
  return null
}

export async function createQuickbooksInvoice(
  call: QuickbooksCall,
  props: { body: Record<string, unknown>; requestId: string },
): Promise<QuickbooksInvoice> {
  const answer = await call({
    method: "POST",
    path: "invoice",
    query: { include: "invoiceLink" },
    body: props.body,
    requestId: props.requestId,
  })
  const invoice = readQuickbooksInvoice(answer.Invoice)
  if (!invoice) {
    throw new Error("QuickBooks answered no invoice")
  }
  return invoice
}

/**
 * Void an invoice (QBO keeps it, zeroed) with its CURRENT SyncToken: it is
 * re-read first, and once more after a stale-object answer. No request id:
 * a void is idempotent by nature, and a cached failure must not stick.
 */
export async function voidQuickbooksInvoice(
  call: QuickbooksCall,
  invoiceId: string,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const current = await getQuickbooksInvoice(call, invoiceId)
    if (!current) {
      throw new Error(`QuickBooks invoice ${invoiceId} not found`)
    }
    try {
      await call({
        method: "POST",
        path: "invoice",
        query: { operation: "void" },
        body: { Id: current.id, SyncToken: current.syncToken },
      })
      return
    } catch (error) {
      if (
        attempt === 0 &&
        error instanceof QuickbooksApiError &&
        error.code === QUICKBOOKS_STALE_OBJECT_CODE
      ) {
        continue
      }
      throw error
    }
  }
}

export async function createQuickbooksPayment(
  call: QuickbooksCall,
  props: { body: Record<string, unknown>; requestId: string },
): Promise<QuickbooksPayment> {
  const answer = await call({
    method: "POST",
    path: "payment",
    body: props.body,
    requestId: props.requestId,
  })
  const payment = readQuickbooksPayment(answer.Payment)
  if (!payment) {
    throw new Error("QuickBooks answered no payment")
  }
  return payment
}

export async function findQuickbooksCustomerByEmail(
  call: QuickbooksCall,
  email: string,
): Promise<string | null> {
  const rows = await queryRows(
    call,
    "Customer",
    `select Id from Customer where PrimaryEmailAddr = ${quickbooksQueryLiteral(email)} and Active = true`,
  )
  return rows.length === 1 ? str(rows[0]?.Id) : null
}

const DUPLICATE_NAME_CODE = "6240"
const DUPLICATE_ID = /customer ID is:?\s*(\d{1,20})/i

/**
 * Create a customer. A 6240 "Duplicate Name Exists" answer names the
 * customer that already has this DisplayName: the hub's DisplayNames carry
 * the contact id, so that customer IS this contact's (an earlier create
 * whose answer was lost) and is adopted.
 */
export async function createQuickbooksCustomer(
  call: QuickbooksCall,
  props: { body: Record<string, unknown>; requestId: string },
): Promise<string> {
  let answer: Record<string, unknown>
  try {
    answer = await call({
      method: "POST",
      path: "customer",
      body: props.body,
      requestId: props.requestId,
    })
  } catch (error) {
    const existing =
      error instanceof QuickbooksApiError && error.code === DUPLICATE_NAME_CODE
        ? DUPLICATE_ID.exec(error.message)?.[1]
        : undefined
    if (existing) {
      return existing
    }
    throw error
  }
  const id = str(obj(answer.Customer)?.Id)
  if (!id) {
    throw new Error("QuickBooks answered no customer id")
  }
  return id
}

export type QuickbooksChange = {
  entity: "Invoice" | "Payment"
  id: string
  deleted: boolean
  lastUpdated: string | null
}

/** Invoice and Payment changes since `since` (Change Data Capture). */
export async function readQuickbooksChanges(
  call: QuickbooksCall,
  since: Date,
): Promise<QuickbooksChange[]> {
  const answer = await call({
    method: "GET",
    path: "cdc",
    query: { entities: "Invoice,Payment", changedSince: since.toISOString() },
  })
  const changes: QuickbooksChange[] = []
  const responses = Array.isArray(answer.CDCResponse) ? answer.CDCResponse : []
  for (const response of responses.slice(0, 10)) {
    const queries = obj(response)?.QueryResponse
    for (const query of Array.isArray(queries) ? queries.slice(0, 10) : []) {
      for (const entity of ["Invoice", "Payment"] as const) {
        const rows = obj(query)?.[entity]
        for (const row of Array.isArray(rows) ? rows.slice(0, 1000) : []) {
          const r = obj(row)
          const id = str(r?.Id)
          if (id) {
            changes.push({
              entity,
              id,
              deleted: r?.status === "Deleted",
              lastUpdated: str(obj(r?.MetaData)?.LastUpdatedTime),
            })
          }
        }
      }
    }
  }
  return changes
}
