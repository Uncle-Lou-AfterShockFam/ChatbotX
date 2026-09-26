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

vi.mock("@chatbotx.io/business/invoice", () => ({ visitCheckout }))
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
  })
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
