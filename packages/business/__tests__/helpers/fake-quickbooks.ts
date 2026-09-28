import { HttpResponse, http } from "@chatbotx.io/vitest-config/msw"

/**
 * An in-memory QuickBooks Online company behind MSW (s214b): the token
 * endpoint (with ROTATING refresh tokens: a used one is refused with
 * invalid_grant, as Intuit documents), the query language subset the hub
 * uses, customers, items, invoices (SyncToken, void, InvoiceLink only with
 * online payments on and a BillEmail), payments that pay down linked
 * invoices, CDC, and `requestid` replay. Every API call is recorded.
 */
export type FakeCall = {
  method: string
  path: string
  requestId: string | null
  body: unknown
}

type Row = Record<string, unknown>

const FROM_ENTITY = /from (\w+)/i
const ENTITY_READ = /^(invoice|payment)\/(\d+)$/

export function fakeQuickbooks(options: { realmId?: string } = {}) {
  const realmId = options.realmId ?? "9130357766900001"
  const state = {
    realmId,
    accessToken: "at-0",
    refreshToken: "rt-0",
    refreshes: 0,
    /** Resolve before answering a refresh (lets a test hold one open). */
    refreshGate: null as Promise<void> | null,
    paymentsEnabled: true,
    /** Added to every created invoice's total (a QBO sales-tax surprise). */
    taxOnCreate: 0,
    homeCurrency: "USD",
    multicurrency: false,
    customers: new Map<string, Row>(),
    items: new Map<string, Row>(),
    invoices: new Map<string, Row>(),
    payments: new Map<string, Row>(),
    replays: new Map<string, Row>(),
    calls: [] as FakeCall[],
    /** "<METHOD> <path>" whose next call is PERFORMED but answered 500 (a lost answer). */
    dropAnswer: new Set<string>(),
    /** "<METHOD> <path prefix>" -> [status, body], answered once. */
    failNext: new Map<string, [number, Row]>(),
    nextId: 100,
  }
  const id = () => String(++state.nextId)
  const fault = (status: number, code: string, message: string) =>
    HttpResponse.json(
      {
        Fault: {
          Error: [{ Message: message, Detail: message, code }],
          type: "ValidationFault",
        },
      },
      { status },
    )

  const api = (path: string) =>
    `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}/${path}`

  const record = async (request: Request, path: string) => {
    const url = new URL(request.url)
    let body: unknown = null
    if (request.method === "POST") {
      body = await request.json().catch(() => null)
    }
    state.calls.push({
      method: request.method,
      path,
      requestId: url.searchParams.get("requestid"),
      body,
    })
    return { url, body: body as Row | null }
  }

  const authorized = (request: Request) =>
    request.headers.get("authorization") === `Bearer ${state.accessToken}`

  const failed = (method: string, path: string) => {
    for (const [prefix, answer] of state.failNext) {
      if (`${method} ${path}`.startsWith(prefix)) {
        state.failNext.delete(prefix)
        return HttpResponse.json(answer[1], { status: answer[0] })
      }
    }
    return null
  }

  const replay = (url: URL, key: string, make: () => Row) => {
    const requestId = url.searchParams.get("requestid")
    const cacheKey = requestId ? `${key}:${requestId}` : null
    if (cacheKey && state.replays.has(cacheKey)) {
      return state.replays.get(cacheKey) as Row
    }
    const answer = make()
    if (cacheKey) {
      state.replays.set(cacheKey, answer)
    }
    return answer
  }

  const withLink = (invoice: Row) =>
    state.paymentsEnabled &&
    invoice.BillEmail &&
    invoice.AllowOnlineCreditCardPayment
      ? {
          ...invoice,
          InvoiceLink: `https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-${invoice.Id}`,
        }
      : invoice

  const literal = (query: string, field: string): string | null => {
    const match = new RegExp(
      `${field.replace(".", "\\.")} = '((?:[^'\\\\]|\\\\.)*)'`,
    ).exec(query)
    return match ? (match[1] as string).replaceAll("\\'", "'") : null
  }

  const query = (q: string): Row => {
    const entity = FROM_ENTITY.exec(q)?.[1] ?? ""
    if (entity === "Item") {
      const name = literal(q, "Name")
      return {
        QueryResponse: {
          Item: [...state.items.values()].filter((i) => i.Name === name),
        },
      }
    }
    if (entity === "Account") {
      return {
        QueryResponse: { Account: [{ Id: "79", AccountType: "Income" }] },
      }
    }
    if (entity === "Customer") {
      const email = literal(q, "PrimaryEmailAddr")
      return {
        QueryResponse: {
          Customer: [...state.customers.values()].filter(
            (c) => (c.PrimaryEmailAddr as Row | undefined)?.Address === email,
          ),
        },
      }
    }
    if (entity === "Invoice" || entity === "Payment") {
      const customer = literal(q, "CustomerRef")
      const map = entity === "Invoice" ? state.invoices : state.payments
      return {
        QueryResponse: {
          [entity]: [...map.values()].filter(
            (row) => (row.CustomerRef as Row).value === customer,
          ),
        },
      }
    }
    return { QueryResponse: {} }
  }

  const createInvoice = (body: Row): Row => {
    const lines = (body.Line as Row[]) ?? []
    const total =
      Math.round(
        (lines.reduce((sum, line) => sum + Number(line.Amount), 0) +
          state.taxOnCreate) *
          100,
      ) / 100
    const invoice: Row = {
      ...body,
      Id: id(),
      SyncToken: "0",
      TotalAmt: total,
      Balance: total,
      MetaData: {
        CreateTime: new Date().toISOString(),
        LastUpdatedTime: new Date().toISOString(),
      },
    }
    state.invoices.set(invoice.Id as string, invoice)
    return withLink(invoice)
  }

  const bump = (invoice: Row) => {
    invoice.SyncToken = String(Number(invoice.SyncToken) + 1)
    invoice.MetaData = {
      ...(invoice.MetaData as Row),
      LastUpdatedTime: new Date().toISOString(),
    }
  }

  /** A payment applied to invoices (what a customer paying online produces). */
  const applyPayment = (body: Row): Row => {
    const payment: Row = {
      ...body,
      Id: id(),
      SyncToken: "0",
      MetaData: {
        CreateTime: new Date().toISOString(),
        LastUpdatedTime: new Date().toISOString(),
      },
    }
    for (const line of (body.Line as Row[]) ?? []) {
      for (const txn of (line.LinkedTxn as Row[]) ?? []) {
        const invoice = state.invoices.get(txn.TxnId as string)
        if (invoice) {
          invoice.Balance = Math.max(
            0,
            Number(invoice.Balance) - Number(line.Amount),
          )
          bump(invoice)
        }
      }
    }
    state.payments.set(payment.Id as string, payment)
    return payment
  }

  const handlers = [
    http.post(
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      async ({ request }) => {
        const form = new URLSearchParams(await request.text())
        if (state.refreshGate) {
          await state.refreshGate
        }
        if (form.get("grant_type") === "refresh_token") {
          if (form.get("refresh_token") !== state.refreshToken) {
            return HttpResponse.json(
              { error: "invalid_grant" },
              { status: 400 },
            )
          }
          state.refreshes += 1
        } else if (form.get("code") !== "good-code") {
          return HttpResponse.json({ error: "invalid_grant" }, { status: 400 })
        }
        state.accessToken = `at-${state.refreshes + 1}-${Date.now()}`
        state.refreshToken = `rt-${state.refreshes + 1}-${Date.now()}`
        return HttpResponse.json({
          token_type: "bearer",
          access_token: state.accessToken,
          refresh_token: state.refreshToken,
          expires_in: 3600,
          x_refresh_token_expires_in: 8_640_000,
        })
      },
    ),
    http.post("https://developer.api.intuit.com/v2/oauth2/tokens/revoke", () =>
      HttpResponse.json({}),
    ),
    http.all(
      `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}/*`,
      async ({ request }) => {
        const url = new URL(request.url)
        const path = url.pathname.split(`/v3/company/${realmId}/`)[1] ?? ""
        const { body } = await record(request, path)
        if (!authorized(request)) {
          return fault(401, "3200", "AuthenticationFailed")
        }
        const failure = failed(request.method, path)
        if (failure) {
          return failure
        }
        if (path === `companyinfo/${realmId}`) {
          return HttpResponse.json({
            CompanyInfo: { CompanyName: "Fake Bakery LLC" },
          })
        }
        if (path === "preferences") {
          return HttpResponse.json({
            Preferences: {
              CurrencyPrefs: {
                HomeCurrency: { value: state.homeCurrency },
                MultiCurrencyEnabled: state.multicurrency,
              },
            },
          })
        }
        if (path === "query") {
          return HttpResponse.json(query(url.searchParams.get("query") ?? ""))
        }
        if (path === "item" && body) {
          const item = replay(url, "item", () => {
            const row = { ...body, Id: id() }
            state.items.set(row.Id as string, row)
            return row
          })
          return HttpResponse.json({ Item: item })
        }
        if (path === "customer" && body) {
          const requestId = url.searchParams.get("requestid")
          const cached = requestId
            ? state.replays.get(`customer:${requestId}`)
            : undefined
          if (cached) {
            return HttpResponse.json({ Customer: cached })
          }
          const clash = [...state.customers.values()].find(
            (c) => c.DisplayName === body.DisplayName,
          )
          if (clash) {
            return fault(
              400,
              "6240",
              `Duplicate Name Exists Error. The customer ID is: ${clash.Id}`,
            )
          }
          const customer = replay(url, "customer", () => {
            const row = { ...body, Id: id() }
            state.customers.set(row.Id as string, row)
            return row
          })
          return HttpResponse.json({ Customer: customer })
        }
        if (
          path === "invoice" &&
          body &&
          url.searchParams.get("operation") === "void"
        ) {
          const invoice = state.invoices.get(body.Id as string)
          if (!invoice) {
            return fault(400, "610", "Object Not Found")
          }
          if (invoice.SyncToken !== body.SyncToken) {
            return fault(400, "5010", "Stale Object Error")
          }
          invoice.TotalAmt = 0
          invoice.Balance = 0
          invoice.PrivateNote = `Voided - ${invoice.PrivateNote ?? ""}`
          bump(invoice)
          return HttpResponse.json({ Invoice: invoice })
        }
        if (path === "invoice" && body) {
          const created = replay(url, "invoice", () => createInvoice(body))
          if (state.dropAnswer.delete("POST invoice")) {
            return HttpResponse.json({}, { status: 500 })
          }
          return HttpResponse.json({ Invoice: created })
        }
        if (path === "payment" && body) {
          return HttpResponse.json({
            Payment: replay(url, "payment", () => applyPayment(body)),
          })
        }
        const read = ENTITY_READ.exec(path)
        if (read) {
          const map = read[1] === "invoice" ? state.invoices : state.payments
          const row = map.get(read[2] as string)
          if (!row) {
            return fault(400, "610", "Object Not Found")
          }
          return HttpResponse.json({
            [read[1] === "invoice" ? "Invoice" : "Payment"]:
              read[1] === "invoice" ? withLink(row) : row,
          })
        }
        if (path === "cdc") {
          const since = Date.parse(url.searchParams.get("changedSince") ?? "")
          const changed = (map: Map<string, Row>) =>
            [...map.values()].filter(
              (row) =>
                Date.parse((row.MetaData as Row).LastUpdatedTime as string) >=
                since,
            )
          return HttpResponse.json({
            CDCResponse: [
              {
                QueryResponse: [
                  { Invoice: changed(state.invoices) },
                  { Payment: changed(state.payments) },
                ],
              },
            ],
          })
        }
        return fault(400, "2010", `Unsupported ${request.method} ${path}`)
      },
    ),
  ]

  return {
    state,
    handlers,
    api,
    /** The customer pays an invoice in full through QuickBooks Payments. */
    pay(invoiceId: string): Row {
      const invoice = state.invoices.get(invoiceId)
      if (!invoice) {
        throw new Error(`fake: no invoice ${invoiceId}`)
      }
      return applyPayment({
        CustomerRef: invoice.CustomerRef,
        TotalAmt: invoice.Balance,
        Line: [
          {
            Amount: invoice.Balance,
            LinkedTxn: [{ TxnId: invoiceId, TxnType: "Invoice" }],
          },
        ],
      })
    },
    apiCalls: (method: string, pathPrefix: string) =>
      state.calls.filter(
        (c) => c.method === method && c.path.startsWith(pathPrefix),
      ),
  }
}
