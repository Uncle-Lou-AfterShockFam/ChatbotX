// @vitest-environment node
import { beforeEach, expect, test, vi } from "vitest"

/**
 * `/pay/<token>/pdf` (s210b): the route maps each PDF visit to one answer.
 * `visitInvoicePdf` (lookup, render, store) is tested in business; here the
 * status codes, headers and logging are pinned.
 */
const visitInvoicePdf = vi.fn()
const loadServableWorkspace = vi.fn()
const checkApiRateLimit = vi.fn()
const error = vi.fn()

vi.mock("@chatbotx.io/business/invoice", () => ({ visitInvoicePdf }))
vi.mock("@chatbotx.io/filesystem", () => ({ uploader: {} }))
vi.mock("@/lib/workspace/load-servable-workspace", () => ({
  loadServableWorkspace,
}))
vi.mock("@/lib/rate-limit/api-rate-limit", () => ({ checkApiRateLimit }))
vi.mock("@/lib/log", () => ({ logger: { error, warn: vi.fn() } }))
vi.mock("@/app/integrations/documenso/webhook/route", () => ({
  documensoWebhookRateLimitKey: () => "203.0.113.9",
}))

const TOKEN = "0123456789ABCDEFGHIJKL"
const PDF = Buffer.from("%PDF-1.7 test %%EOF")
const get = async (token = TOKEN) => {
  const { GET } = await import("@/app/pay/[token]/pdf/route")
  return GET(new Request(`http://localhost/pay/${token}/pdf`), {
    params: Promise.resolve({ token }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  checkApiRateLimit.mockResolvedValue({ limited: false, retryAfter: 1 })
  loadServableWorkspace.mockResolvedValue({ servable: true })
})

test("a document is served inline as a private, unindexed PDF", async () => {
  visitInvoicePdf.mockResolvedValue({
    kind: "pdf",
    pdf: PDF,
    title: "Receipt #4",
  })
  const res = await get()
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toBe("application/pdf")
  expect(res.headers.get("content-length")).toBe(String(PDF.length))
  expect(res.headers.get("content-disposition")).toBe(
    'inline; filename="Receipt-4.pdf"',
  )
  expect(res.headers.get("cache-control")).toBe("private, no-store")
  expect(res.headers.get("x-content-type-options")).toBe("nosniff")
  expect(res.headers.get("x-robots-tag")).toContain("noindex")
  expect(Buffer.from(await res.arrayBuffer())).toEqual(PDF)
})

test("no document (unknown token, draft, void, stripeInvoice) is a 404 page", async () => {
  visitInvoicePdf.mockResolvedValue({ kind: "notFound" })
  const res = await get("nope")
  expect(res.status).toBe(404)
  expect(res.headers.get("content-type")).toContain("text/html")
})

test("the freeze gate is handed to the visit; frozen is a 410", async () => {
  loadServableWorkspace.mockResolvedValue({ servable: false })
  visitInvoicePdf.mockImplementation(
    async (
      _token: string,
      options: { canServe: (ws: string) => Promise<boolean> },
    ) =>
      (await options.canServe("11"))
        ? { kind: "pdf", pdf: PDF, title: "Invoice #4" }
        : { kind: "frozen" },
  )
  const res = await get()
  expect(loadServableWorkspace).toHaveBeenCalledWith("11")
  expect(res.status).toBe(410)
})

test("a failed render or store is a 503 with retry-after, logged by token prefix only", async () => {
  visitInvoicePdf.mockRejectedValue(
    new Error("Could not render the PDF (timeout)"),
  )
  const res = await get()
  expect(res.status).toBe(503)
  expect(res.headers.get("retry-after")).toBe("60")
  const logged = String(error.mock.calls[0]?.[1])
  expect(logged).toContain("0123...")
  expect(logged).not.toContain(TOKEN)
})

test("a rate-limited caller gets 429 before any lookup", async () => {
  checkApiRateLimit.mockResolvedValue({ limited: true, retryAfter: 7 })
  const res = await get()
  expect(res.status).toBe(429)
  expect(res.headers.get("retry-after")).toBe("7")
  expect(visitInvoicePdf).not.toHaveBeenCalled()
  expect(checkApiRateLimit).toHaveBeenCalledWith(
    expect.objectContaining({
      scope: "invoice-pdf-rate-limit",
      key: "203.0.113.9",
    }),
  )
})
