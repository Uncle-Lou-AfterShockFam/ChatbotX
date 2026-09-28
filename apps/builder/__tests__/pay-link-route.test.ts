// @vitest-environment node
import { beforeEach, expect, test, vi } from "vitest"

/**
 * `/pay/<token>` (s207b): the route maps each visit outcome to one answer.
 * `visitCheckout` (the session logic) is tested in business; here it is
 * mocked and the route's status codes, redirect, headers and escaping are
 * pinned.
 */
const visitCheckout = vi.fn()
const loadServableWorkspace = vi.fn()
const checkApiRateLimit = vi.fn()
const error = vi.fn()

vi.mock("@chatbotx.io/business/invoice", () => ({
  visitCheckout,
  // The real formatter falls back to "<value> <currency>" for a code Intl
  // rejects; the same shape keeps the escaping test meaningful.
  formatInvoiceMoney: (value: string, currency: string) =>
    `${value} ${currency}`,
  formatInvoiceMinor: (minor: bigint, currency: string) =>
    `${(Number(minor) / 100).toFixed(2)} ${currency}`,
  amountDueMinor: (row: { total: string; amountPaid: string }) =>
    BigInt(Math.round(Number(row.total) * 100)) -
    BigInt(Math.round(Number(row.amountPaid) * 100)),
}))
vi.mock("@/lib/workspace/load-servable-workspace", () => ({
  loadServableWorkspace,
}))
vi.mock("@/lib/rate-limit/api-rate-limit", () => ({ checkApiRateLimit }))
vi.mock("@/lib/log", () => ({ logger: { error, warn: vi.fn() } }))
vi.mock("@/app/integrations/documenso/webhook/route", () => ({
  documensoWebhookRateLimitKey: () => "203.0.113.9",
}))

const TOKEN = "0123456789ABCDEFGHIJKL"
const invoice = {
  id: "501",
  workspaceId: "11",
  number: 4,
  total: "12.50",
  currency: "USD",
}
const get = async (token = TOKEN) => {
  const { GET } = await import("@/app/pay/[token]/route")
  return GET(new Request(`http://localhost/pay/${token}`), {
    params: Promise.resolve({ token }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  checkApiRateLimit.mockResolvedValue({ limited: false, retryAfter: 1 })
  loadServableWorkspace.mockResolvedValue({ servable: true })
})

test("a live session is a 303 to Stripe, never cached", async () => {
  visitCheckout.mockResolvedValue({
    kind: "redirect",
    url: "https://checkout.stripe.com/c/pay/cs_test_1",
    invoice,
  })
  const res = await get()
  expect(res.status).toBe(303)
  expect(res.headers.get("location")).toBe(
    "https://checkout.stripe.com/c/pay/cs_test_1",
  )
  expect(res.headers.get("cache-control")).toBe("private, no-store")
  expect(visitCheckout).toHaveBeenCalledWith(TOKEN, {
    canServe: expect.any(Function),
    requestedKind: undefined,
    justPaid: false,
  })
})

const post = async (kind: string, token = TOKEN) => {
  const { POST } = await import("@/app/pay/[token]/route")
  const body = new URLSearchParams({ kind })
  return POST(
    new Request(`http://localhost/pay/${token}`, { method: "POST", body }),
    { params: Promise.resolve({ token }) },
  )
}

test("s216b: a GET never picks a kind, even with ?kind= (a scanner cannot switch the session)", async () => {
  visitCheckout.mockResolvedValue({ kind: "notFound" })
  const { GET } = await import("@/app/pay/[token]/route")
  await GET(new Request(`http://localhost/pay/${TOKEN}?kind=full`), {
    params: Promise.resolve({ token: TOKEN }),
  })
  expect(visitCheckout).toHaveBeenCalledWith(
    TOKEN,
    expect.objectContaining({ requestedKind: undefined }),
  )
})

test("s216b: the pick is a POST form; a 303 follows to Stripe", async () => {
  visitCheckout.mockResolvedValue({
    kind: "redirect",
    url: "https://checkout.stripe.com/c/pay/cs_dep",
    invoice,
  })
  const res = await post("deposit")
  expect(res.status).toBe(303)
  expect(visitCheckout).toHaveBeenCalledWith(
    TOKEN,
    expect.objectContaining({ requestedKind: "deposit", justPaid: false }),
  )
})

test("s216b: the choice page offers the deposit and the full amount as POST forms", async () => {
  visitCheckout.mockResolvedValue({
    kind: "choose",
    invoice: { ...invoice, total: "200.00" },
    depositMinor: 5000n,
    totalMinor: 20_000n,
  })
  const res = await get()
  const html = await res.text()
  expect(res.status).toBe(200)
  expect(
    html.match(/<form method="post" action="\/pay\/0123456789ABCDEFGHIJKL">/g),
  ).toHaveLength(2)
  expect(html).toContain('name="kind" value="deposit"')
  expect(html).toContain('name="kind" value="full"')
  expect(html).toContain("Pay deposit (50.00 USD)")
  expect(html).toContain("Pay in full (200.00 USD)")
  expect(res.headers.get("content-security-policy")).toContain(
    "form-action 'self' https://checkout.stripe.com",
  )
})

test("s216b: back from Stripe after a deposit: the deposit page with the balance and a pay-balance button", async () => {
  visitCheckout.mockResolvedValue({
    kind: "depositPaid",
    invoice: { ...invoice, total: "200.00", amountPaid: "50.00" },
  })
  const { GET } = await import("@/app/pay/[token]/route")
  const res = await GET(new Request(`http://localhost/pay/${TOKEN}?done=1`), {
    params: Promise.resolve({ token: TOKEN }),
  })
  expect(visitCheckout).toHaveBeenCalledWith(
    TOKEN,
    expect.objectContaining({ justPaid: true }),
  )
  const html = await res.text()
  expect(html).toContain("Deposit received")
  expect(html).toContain("The balance of 150.00 USD is due")
  expect(html).toContain(`href="/pay/${TOKEN}"`)
})

test.each([
  ["paid", 200, "is paid"],
  ["processing", 200, "being confirmed"],
  ["closed", 410, "no longer payable"],
  ["unavailable", 503, "not available right now"],
])("%s -> %i page", async (kind, status, text) => {
  visitCheckout.mockResolvedValue({ kind, invoice })
  const res = await get()
  expect(res.status).toBe(status)
  expect(res.headers.get("content-type")).toContain("text/html")
  expect(res.headers.get("content-security-policy")).toContain(
    "default-src 'none'",
  )
  expect(res.headers.get("cache-control")).toBe("private, no-store")
  expect(res.headers.get("x-robots-tag")).toContain("noindex")
  const html = await res.text()
  expect(html).toContain(text)
  expect(html).toContain("Invoice #4 (12.50 USD)")
})

test("an unknown token is a 404", async () => {
  visitCheckout.mockResolvedValue({ kind: "notFound" })
  const res = await get("nope")
  expect(res.status).toBe(404)
})

test("the freeze gate is handed to the visit, which asks it before minting", async () => {
  loadServableWorkspace.mockResolvedValue({ servable: false })
  visitCheckout.mockImplementation(
    async (
      _token: string,
      options: { canServe: (ws: string) => Promise<boolean> },
    ) =>
      (await options.canServe("11"))
        ? { kind: "redirect", url: "https://checkout.stripe.com/x", invoice }
        : { kind: "frozen", invoice },
  )
  const res = await get()
  expect(loadServableWorkspace).toHaveBeenCalledWith("11")
  expect(res.status).toBe(410)
  expect(res.headers.get("location")).toBeNull()
})

test("a thrown visit (Stripe down) is a 503 page and is logged with a token prefix only", async () => {
  visitCheckout.mockRejectedValue(new Error("Stripe create checkout session"))
  const res = await get()
  expect(res.status).toBe(503)
  const logged = String(error.mock.calls[0]?.[1])
  expect(logged).toContain("0123...")
  expect(logged).not.toContain(TOKEN)
})

test("a rate-limited caller gets 429 before any lookup", async () => {
  checkApiRateLimit.mockResolvedValue({ limited: true, retryAfter: 7 })
  const res = await get()
  expect(res.status).toBe(429)
  expect(res.headers.get("retry-after")).toBe("7")
  expect(visitCheckout).not.toHaveBeenCalled()
  expect(checkApiRateLimit).toHaveBeenCalledWith(
    expect.objectContaining({
      scope: "invoice-pay-link-rate-limit",
      key: "203.0.113.9",
    }),
  )
})

test("invoice values on the page are HTML-escaped", async () => {
  visitCheckout.mockResolvedValue({
    kind: "paid",
    invoice: { ...invoice, currency: "<b>", total: '"><script>' },
  })
  const html = await (await get()).text()
  expect(html).not.toContain("<script>")
  expect(html).not.toContain("<b>")
  expect(html).toContain("&lt;script&gt;")
})

test("a paid page links the receipt PDF; a refunded one does not", async () => {
  visitCheckout.mockResolvedValue({
    kind: "paid",
    invoice: { ...invoice, status: "paid" },
  })
  const paid = await (await get()).text()
  expect(paid).toContain(`href="/pay/${TOKEN}/pdf"`)
  expect(paid).toContain("Download receipt (PDF)")

  visitCheckout.mockResolvedValue({
    kind: "paid",
    invoice: { ...invoice, status: "refunded" },
  })
  const refunded = await (await get()).text()
  expect(refunded).toContain("is paid")
  expect(refunded).not.toContain("/pdf")
})
