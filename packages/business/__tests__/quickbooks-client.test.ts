import { HttpResponse, http, server } from "@chatbotx.io/vitest-config/msw"
import { describe, expect, test } from "vitest"
import {
  buildQuickbooksAuthorizeUrl,
  QUICKBOOKS_MINOR_VERSION,
  QuickbooksApiError,
  QuickbooksReconnectRequiredError,
  quickbooksFault,
  quickbooksQueryLiteral,
  quickbooksRequest,
  refreshQuickbooksTokens,
} from "../src/integration-quickbooks/client"
import {
  isQuickbooksInvoicePaid,
  readQuickbooksInvoice,
  readQuickbooksPayment,
} from "../src/integration-quickbooks/entities"

const REALM = "9130357766900001"
const API = `https://sandbox-quickbooks.api.intuit.com/v3/company/${REALM}`
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
const CLIENT = { clientId: "client", clientSecret: "secret" }

const call = (
  overrides: Partial<Parameters<typeof quickbooksRequest>[0]> = {},
) =>
  quickbooksRequest({
    environment: "sandbox",
    realmId: REALM,
    accessToken: "at",
    method: "GET",
    path: "invoice/5",
    ...overrides,
  })

describe("quickbooks client (s214b)", () => {
  test("authorize URL carries both scopes, the redirect and the state", () => {
    const url = new URL(
      buildQuickbooksAuthorizeUrl({
        clientId: "abc",
        redirectUri:
          "https://chat.example.org/integrations/quickbooks/callback",
        state: "s1",
      }),
    )
    expect(url.origin + url.pathname).toBe(
      "https://appcenter.intuit.com/connect/oauth2",
    )
    expect(url.searchParams.get("scope")).toBe(
      "com.intuit.quickbooks.accounting com.intuit.quickbooks.payment",
    )
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("state")).toBe("s1")
  })

  test("a write carries requestid and the pinned minorversion", async () => {
    let seen: URL | null = null
    server.use(
      http.post(`${API}/invoice`, ({ request }) => {
        seen = new URL(request.url)
        return HttpResponse.json({ Invoice: { Id: "1", SyncToken: "0" } })
      }),
    )
    await call({
      method: "POST",
      path: "invoice",
      body: {},
      requestId: "hub-inv-1-abc",
    })
    expect(seen?.searchParams.get("requestid")).toBe("hub-inv-1-abc")
    expect(seen?.searchParams.get("minorversion")).toBe(
      QUICKBOOKS_MINOR_VERSION,
    )
  })

  test("429 is retryable with its Retry-After; 5xx retryable; 401 authRejected", async () => {
    server.use(
      http.get(`${API}/invoice/5`, () =>
        HttpResponse.json(
          {},
          { status: 429, headers: { "retry-after": "60" } },
        ),
      ),
    )
    const limited = await call().catch((e) => e)
    expect(limited).toBeInstanceOf(QuickbooksApiError)
    expect(limited).toMatchObject({ retryable: true, retryAfterSeconds: 60 })

    server.use(
      http.get(`${API}/invoice/5`, () =>
        HttpResponse.json({}, { status: 503 }),
      ),
    )
    await expect(call()).rejects.toMatchObject({ retryable: true })

    server.use(
      http.get(`${API}/invoice/5`, () =>
        HttpResponse.json({}, { status: 401 }),
      ),
    )
    await expect(call()).rejects.toMatchObject({
      authRejected: true,
      retryable: false,
    })
  })

  test("a Fault is an error even with HTTP 200, and its code is kept", async () => {
    server.use(
      http.get(`${API}/invoice/5`, () =>
        HttpResponse.json({
          Fault: {
            Error: [{ Message: "Stale", Detail: "sync", code: "5010" }],
          },
        }),
      ),
    )
    await expect(call()).rejects.toMatchObject({
      code: "5010",
      retryable: false,
    })
  })

  test("a 400 ValidationFault is permanent; a non-JSON body is retryable", async () => {
    server.use(
      http.get(`${API}/invoice/5`, () =>
        HttpResponse.json(
          { Fault: { Error: [{ Message: "Bad", code: "2020" }] } },
          { status: 400 },
        ),
      ),
    )
    await expect(call()).rejects.toMatchObject({
      retryable: false,
      code: "2020",
    })
    server.use(
      http.get(
        `${API}/invoice/5`,
        () => new HttpResponse("<html>", { status: 400 }),
      ),
    )
    await expect(call()).rejects.toMatchObject({ retryable: true })
  })

  test.each([
    ["realm", { realmId: "abc" }],
    ["realm length", { realmId: "1".repeat(33) }],
    ["path traversal", { path: "../../other/invoice" }],
    ["path query", { path: "invoice?x=1" }],
    ["request id", { requestId: "has space" }],
    ["request id length", { requestId: "x".repeat(51) }],
  ])("refuses a bad %s before any request", async (_label, overrides) => {
    await expect(call(overrides)).rejects.toBeInstanceOf(QuickbooksApiError)
  })

  test("invalid_grant on refresh means reconnect, not retry", async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({ error: "invalid_grant" }, { status: 400 }),
      ),
    )
    await expect(
      refreshQuickbooksTokens({ client: CLIENT, refreshToken: "old" }),
    ).rejects.toBeInstanceOf(QuickbooksReconnectRequiredError)
  })

  test("a refresh answer without tokens is refused (retryable)", async () => {
    server.use(
      http.post(TOKEN_URL, () => HttpResponse.json({ access_token: "a" })),
    )
    await expect(
      refreshQuickbooksTokens({ client: CLIENT, refreshToken: "r" }),
    ).rejects.toMatchObject({ retryable: true })
  })

  test("a refresh sends Basic auth and returns the ROTATED refresh token", async () => {
    let auth: string | null = null
    server.use(
      http.post(TOKEN_URL, ({ request }) => {
        auth = request.headers.get("authorization")
        return HttpResponse.json({
          access_token: "at-new",
          refresh_token: "rt-new",
          expires_in: 3600,
          x_refresh_token_expires_in: 8_640_000,
        })
      }),
    )
    const before = Date.now()
    const tokens = await refreshQuickbooksTokens({
      client: CLIENT,
      refreshToken: "rt-old",
    })
    expect(auth).toBe(
      `Basic ${Buffer.from("client:secret").toString("base64")}`,
    )
    expect(tokens.refreshToken).toBe("rt-new")
    expect(tokens.accessExpiresAt).toBeGreaterThanOrEqual(before + 3_600_000)
  })

  test("query literals escape quotes and refuse control characters", () => {
    expect(quickbooksQueryLiteral("O'Brien")).toBe("'O\\'Brien'")
    expect(() => quickbooksQueryLiteral("a\\' or 1=1")).toThrow()
    expect(() => quickbooksQueryLiteral("line\nbreak")).toThrow()
    expect(() => quickbooksQueryLiteral("x".repeat(201))).toThrow()
  })

  test("fault reader tolerates junk", () => {
    expect(quickbooksFault(null)).toEqual({ code: "", message: "" })
    expect(quickbooksFault({ Fault: { Error: "x" } })).toEqual({
      code: "",
      message: "",
    })
  })
})

describe("quickbooks entity readers (s214b)", () => {
  test("an invoice needs Id and SyncToken; paid = positive total, zero balance", () => {
    expect(readQuickbooksInvoice({ Id: "1" })).toBeNull()
    expect(readQuickbooksInvoice(null)).toBeNull()
    expect(readQuickbooksInvoice([])).toBeNull()
    const open = readQuickbooksInvoice({
      Id: "1",
      SyncToken: "0",
      TotalAmt: 10,
      Balance: 10,
    })
    expect(open && isQuickbooksInvoicePaid(open)).toBe(false)
    const paid = readQuickbooksInvoice({
      Id: "1",
      SyncToken: "2",
      TotalAmt: 10,
      Balance: 0,
    })
    expect(paid && isQuickbooksInvoicePaid(paid)).toBe(true)
    // A voided invoice is zeroed: never "paid".
    const voided = readQuickbooksInvoice({
      Id: "1",
      SyncToken: "3",
      TotalAmt: 0,
      Balance: 0,
    })
    expect(voided && isQuickbooksInvoicePaid(voided)).toBe(false)
  })

  test("a payment lists only the invoices it is linked to, deduplicated and capped", () => {
    const payment = readQuickbooksPayment({
      Id: "9",
      Line: [
        {
          LinkedTxn: [
            { TxnId: "1", TxnType: "Invoice" },
            { TxnId: "2", TxnType: "CreditMemo" },
          ],
        },
        {
          LinkedTxn: [
            { TxnId: "1", TxnType: "Invoice" },
            { TxnId: "3", TxnType: "Invoice" },
          ],
        },
        "junk",
        { LinkedTxn: "junk" },
      ],
    })
    expect(payment?.invoiceIds).toEqual(["1", "3"])
    const huge = readQuickbooksPayment({
      Id: "9",
      Line: Array.from({ length: 500 }, (_, i) => ({
        LinkedTxn: [{ TxnId: String(i), TxnType: "Invoice" }],
      })),
    })
    expect(huge?.invoiceIds).toHaveLength(100)
  })
})
