import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * The `woocommerce` collection method (s211b): the order.invoice request a
 * hub invoice becomes, and how the site's answers map to an open invoice or a
 * provider error. The HTTP layer is the real `postSiteAction` over a stubbed
 * global fetch; the SSRF guard and the contact read are mocked.
 */

const m = vi.hoisted(() => ({
  contact: { phoneNumber: "+15550004242", email: null } as {
    phoneNumber: string | null
    email: string | null
  } | null,
  unsafe: false,
  fetch: vi.fn(),
}))

vi.mock("@chatbotx.io/database/client", () => {
  const chain: Record<string, unknown> = {}
  chain.from = () => chain
  chain.where = () => chain
  chain.limit = () => Promise.resolve(m.contact ? [m.contact] : [])
  return {
    db: { select: () => chain },
    eq: (_f: unknown, v: unknown) => ({ eq: v }),
  }
})
vi.mock("../src/net/ssrf-guard", () => ({
  isSsrfUnsafeUrl: () => Promise.resolve(m.unsafe),
}))

const {
  cancelWooCommerceOrder,
  createWooCommerceOrder,
  orderInvoiceRequest,
  wooCommerceIdempotencyKey,
  wooCommerceOrderIdOf,
  wooCommerceProviderInvoiceId,
} = await import("../src/invoice/woocommerce-provider")
const { InvoiceProviderError } = await import("../src/invoice/stripe-provider")
const { normalizeSiteUrl } = await import(
  "../src/integration-woocommerce/client"
)

const credentials = {
  integrationId: "88",
  workspaceId: "11",
  siteSlug: "bakery-test",
  siteUrl: "https://bakery.example.org",
  currency: "USD",
  auth: { actionToken: "btc_token", webhookSecret: "whsec_x" },
}

const line = (over: Record<string, unknown> = {}) => ({
  id: "1",
  invoiceId: "501",
  position: 0,
  description: "Deposit",
  quantity: 1,
  unitAmount: "10.00",
  amount: "10.00",
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
})

const invoice = (over: Record<string, unknown> = {}) =>
  ({
    id: "501",
    workspaceId: "11",
    contactId: "31",
    number: 7,
    currency: "USD",
    total: "17.50",
    lineItems: [
      line(),
      line({
        id: "2",
        position: 1,
        description: "Frosting",
        quantity: 3,
        unitAmount: "2.50",
        amount: "7.50",
      }),
    ],
    ...over,
  }) as never

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const invoiced = (over: Record<string, unknown> = {}) =>
  answer(200, {
    ok: true,
    status: "invoiced",
    order_id: 3701,
    pay_url:
      "https://bakery.example.org/checkout/order-pay/3701/?pay_for_order=true&key=wc_order_x",
    total: "17.50",
    tax_total: "0.00",
    currency: "USD",
    hub_invoice_id: "501",
    ...over,
  })

beforeEach(() => {
  m.contact = { phoneNumber: "+15550004242", email: null }
  m.unsafe = false
  m.fetch.mockReset()
  vi.stubGlobal("fetch", m.fetch)
})

describe("orderInvoiceRequest", () => {
  test("every hub line is a fee in position order, with the currency, the total and the hub id", () => {
    const lines = [
      line({ id: "2", position: 1, description: "B", unitAmount: "2.00" }),
      line({ position: 0, description: "A" }),
    ]
    const body = orderInvoiceRequest({
      invoice: invoice(),
      lines: lines as never,
      contact: { phoneNumber: "+15550004242", email: "a@example.org" },
    })
    expect(body).toEqual({
      contact: { phone: "+15550004242", email: "a@example.org" },
      args: {
        lines: [
          { type: "fee", description: "A", amount: "10.00", quantity: 1 },
          { type: "fee", description: "B", amount: "2.00", quantity: 1 },
        ],
        currency: "USD",
        total: "17.50",
        hub_invoice_id: "501",
        note: "Hub invoice #7",
      },
    })
  })

  test("a contact with neither phone nor email is a permanent failure", () => {
    expect(() =>
      orderInvoiceRequest({
        invoice: invoice(),
        lines: [line()] as never,
        contact: { phoneNumber: null, email: null },
      }),
    ).toThrow(
      expect.objectContaining({ retryable: false, name: expect.any(String) }),
    )
  })

  test("a line over the plugin's 10000 cap fails here, before any call", () => {
    let error: unknown
    try {
      orderInvoiceRequest({
        invoice: invoice(),
        lines: [line({ amount: "10000.01", unitAmount: "10000.01" })] as never,
        contact: { phoneNumber: "+15550004242", email: null },
      })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(InvoiceProviderError)
    expect((error as { retryable: boolean }).retryable).toBe(false)
  })

  test("a description over 200 chars is cut with an ellipsis", () => {
    const body = orderInvoiceRequest({
      invoice: invoice(),
      lines: [line({ description: "x".repeat(300) })] as never,
      contact: { phoneNumber: "+15550004242", email: null },
    })
    expect(body.args.lines[0]?.description).toHaveLength(200)
    expect(body.args.lines[0]?.description.endsWith("…")).toBe(true)
  })
})

describe("createWooCommerceOrder", () => {
  test("POSTs order.invoice with the token and a per-invoice idempotency key, and returns the order", async () => {
    m.fetch.mockResolvedValue(invoiced())
    const order = await createWooCommerceOrder({
      credentials,
      invoice: invoice(),
    })
    expect(order).toEqual({
      orderId: "3701",
      payUrl:
        "https://bakery.example.org/checkout/order-pay/3701/?pay_for_order=true&key=wc_order_x",
    })
    const [url, init] = m.fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      "https://bakery.example.org/wp-json/hub-connector/v1/actions/order.invoice",
    )
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe("Bearer btc_token")
    expect(headers["idempotency-key"]).toBe(wooCommerceIdempotencyKey("501"))
    expect(init.redirect).toBe("manual")
    expect(JSON.parse(String(init.body)).args.hub_invoice_id).toBe("501")
  })

  test.each([
    ["another total", { total: "17.49" }],
    ["another currency", { currency: "EUR" }],
    ["another hub invoice", { hub_invoice_id: "502" }],
  ])("an answer with %s is a permanent failure naming the order to cancel", async (_label, over) => {
    m.fetch.mockResolvedValue(invoiced(over))
    const error = await createWooCommerceOrder({
      credentials,
      invoice: invoice(),
    }).catch((e) => e)
    expect(error).toBeInstanceOf(InvoiceProviderError)
    expect(error.retryable).toBe(false)
    expect(error.message).toContain("3701")
  })

  test.each([
    ["an http pay link", { pay_url: "http://bakery.example.org/pay" }],
    ["no order id", { order_id: null }],
  ])("an answer with %s is refused", async (_label, over) => {
    m.fetch.mockResolvedValue(invoiced(over))
    const error = await createWooCommerceOrder({
      credentials,
      invoice: invoice(),
    }).catch((e) => e)
    expect(error).toBeInstanceOf(InvoiceProviderError)
    expect(error.retryable).toBe(false)
  })

  test.each([
    [500, "error", true],
    [503, "", true],
    [429, "", true],
    [429, "rate-limited", true],
    [409, "in-progress", true],
    [409, "total-mismatch", false],
    [409, "hub-invoice-exists", false],
    [409, "currency-mismatch", false],
    [401, "unknown-token", false],
    [403, "scope", false],
    [400, "bad-args", false],
  ])("HTTP %i %s -> retryable %s", async (status, code, retryable) => {
    m.fetch.mockResolvedValue(
      answer(status, { ok: false, status: "error", code, message: "no" }),
    )
    const error = await createWooCommerceOrder({
      credentials,
      invoice: invoice(),
    }).catch((e) => e)
    expect(error).toBeInstanceOf(InvoiceProviderError)
    expect(error.retryable).toBe(retryable)
  })

  test("a redirect is never followed (an answer, refused)", async () => {
    m.fetch.mockResolvedValue(Response.redirect("http://169.254.169.254/", 302))
    const error = await createWooCommerceOrder({
      credentials,
      invoice: invoice(),
    }).catch((e) => e)
    expect(error).toBeInstanceOf(InvoiceProviderError)
    expect(m.fetch).toHaveBeenCalledTimes(1)
  })

  test("a transport failure is retryable", async () => {
    m.fetch.mockRejectedValue(new TypeError("fetch failed"))
    const error = await createWooCommerceOrder({
      credentials,
      invoice: invoice(),
    }).catch((e) => e)
    expect(error).toBeInstanceOf(InvoiceProviderError)
    expect(error.retryable).toBe(true)
  })

  test("a site URL that now resolves to a private address is never called", async () => {
    m.unsafe = true
    const error = await createWooCommerceOrder({
      credentials,
      invoice: invoice(),
    }).catch((e) => e)
    expect(error).toBeInstanceOf(InvoiceProviderError)
    expect(m.fetch).not.toHaveBeenCalled()
  })

  test("an oversized answer is not parsed", async () => {
    m.fetch.mockResolvedValue(
      new Response(`{"ok":true,"pad":"${"x".repeat(70 * 1024)}"}`, {
        status: 200,
      }),
    )
    const error = await createWooCommerceOrder({
      credentials,
      invoice: invoice(),
    }).catch((e) => e)
    expect(error).toBeInstanceOf(InvoiceProviderError)
  })
})

describe("createWooCommerceOrder: recovering an order the site already made", () => {
  const exists = (over: Record<string, unknown> = {}) =>
    answer(409, {
      ok: false,
      status: "error",
      code: "hub-invoice-exists",
      message: "order 3701 (pending) already collects hub invoice 501",
      order_id: 3701,
      order_status: "pending",
      pay_url:
        "https://bakery.example.org/checkout/order-pay/3701/?pay_for_order=true&key=wc_order_x",
      total: "17.50",
      currency: "USD",
      hub_invoice_id: "501",
      ...over,
    })

  test("hub-invoice-exists (the first answer lost, or its key expired) adopts the live order", async () => {
    m.fetch.mockResolvedValue(exists())
    const order = await createWooCommerceOrder({
      credentials,
      invoice: invoice(),
    })
    expect(order.orderId).toBe("3701")
    expect(m.fetch).toHaveBeenCalledTimes(1)
  })

  test("an adopted order that does not match the invoice is refused like a fresh one", async () => {
    m.fetch.mockResolvedValue(exists({ total: "99.00" }))
    const error = await createWooCommerceOrder({
      credentials,
      invoice: invoice(),
    }).catch((e) => e)
    expect(error).toBeInstanceOf(InvoiceProviderError)
    expect(error.retryable).toBe(false)
  })

  test("idempotency-mismatch (the contact changed) retries ONCE under a fresh key, then adopts", async () => {
    m.fetch
      .mockResolvedValueOnce(
        answer(409, { ok: false, code: "idempotency-mismatch", message: "x" }),
      )
      .mockResolvedValueOnce(exists())
    const order = await createWooCommerceOrder({
      credentials,
      invoice: invoice(),
    })
    expect(order.orderId).toBe("3701")
    const keys = m.fetch.mock.calls.map(
      ([, init]) =>
        (init as RequestInit & { headers: Record<string, string> }).headers[
          "idempotency-key"
        ],
    )
    expect(keys).toEqual(["hub-invoice:501", "hub-invoice:501:2"])
  })

  test("a second mismatch is not retried again", async () => {
    m.fetch.mockResolvedValue(
      answer(409, { ok: false, code: "idempotency-mismatch", message: "x" }),
    )
    const error = await createWooCommerceOrder({
      credentials,
      invoice: invoice(),
    }).catch((e) => e)
    expect(error).toBeInstanceOf(InvoiceProviderError)
    expect(m.fetch).toHaveBeenCalledTimes(2)
  })
})

describe("cancelWooCommerceOrder (s213b, hub-connector 0.7.0)", () => {
  const cancel = () =>
    cancelWooCommerceOrder({
      credentials,
      invoice: { id: "501", number: 7 },
      orderId: "3701",
    })

  test("posts order.cancel with the order subject, the hub id and a per-invoice key", async () => {
    m.fetch.mockResolvedValue(
      answer(200, { ok: true, status: "cancelled", order_id: 3701 }),
    )
    await expect(cancel()).resolves.toEqual({ kind: "cancelled" })
    const [url, init] = m.fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      "https://bakery.example.org/wp-json/hub-connector/v1/actions/order.cancel",
    )
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe("Bearer btc_token")
    expect(headers["idempotency-key"]).toBe("hub-invoice:501:cancel")
    expect(JSON.parse(String(init.body))).toEqual({
      subject: { type: "order", id: "3701" },
      args: { hub_invoice_id: "501", reason: "Hub invoice #7 voided" },
    })
  })

  test("already-cancelled is cancelled", async () => {
    m.fetch.mockResolvedValue(
      answer(200, { ok: true, status: "already-cancelled" }),
    )
    await expect(cancel()).resolves.toEqual({ kind: "cancelled" })
  })

  test("order-paid is paid, with the site's status", async () => {
    m.fetch.mockResolvedValue(
      answer(409, {
        ok: false,
        code: "order-paid",
        message: "order 3701 is completed",
        order_status: "completed",
      }),
    )
    await expect(cancel()).resolves.toEqual({
      kind: "paid",
      orderStatus: "completed",
    })
  })

  test.each([
    ["a pre-0.7.0 plugin", 404, { code: "rest_no_route", message: "No route" }],
    ["a revoked token", 401, { ok: false, code: "revoked-token" }],
    ["another invoice's order", 409, { ok: false, code: "invoice-mismatch" }],
    ["a bad status", 409, { ok: false, code: "bad-status" }],
    ["a 200 that is not ok", 200, { ok: false }],
    ["a server error", 500, "<html>"],
  ])("%s is failed, never cancelled or paid", async (_l, status, body) => {
    m.fetch.mockResolvedValue(answer(status, body))
    const outcome = await cancel()
    expect(outcome.kind).toBe("failed")
    expect(outcome).toMatchObject({
      reason: expect.stringContaining(`HTTP ${status}`),
    })
  })

  test("an unreachable or SSRF-unsafe site is failed, never a throw", async () => {
    m.fetch.mockRejectedValue(new TypeError("fetch failed"))
    await expect(cancel()).resolves.toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("did not answer"),
    })
    m.unsafe = true
    await expect(cancel()).resolves.toMatchObject({ kind: "failed" })
  })
})

describe("provider ids", () => {
  test("wc:<origin>:<order> round-trips, and junk yields no order id", () => {
    const ref = wooCommerceProviderInvoiceId(
      "https://shop.example.org:8443",
      42,
    )
    expect(ref).toBe("wc:https://shop.example.org:8443:42")
    expect(wooCommerceOrderIdOf(ref)).toBe("42")
    expect(wooCommerceOrderIdOf("in_stripe_1")).toBeNull()
    expect(wooCommerceOrderIdOf("wc:https://x.org:abc")).toBeNull()
    expect(wooCommerceOrderIdOf(null)).toBeNull()
  })
})

describe("normalizeSiteUrl", () => {
  test.each([
    ["https://shop.example.org", "https://shop.example.org"],
    ["https://shop.example.org/", "https://shop.example.org"],
    ["  https://Shop.Example.org  ", "https://shop.example.org"],
    ["https://shop.example.org:8443", "https://shop.example.org:8443"],
    ["http://shop.example.org", null],
    ["https://shop.example.org/wp", null],
    ["https://shop.example.org/?a=1", null],
    ["https://u:p@shop.example.org", null],
    ["https://shop.example.org/#x", null],
    ["not a url", null],
  ])("%s -> %s", (input, want) => {
    expect(normalizeSiteUrl(input)).toBe(want)
  })
})
