// @vitest-environment node
import { beforeEach, expect, test, vi } from "vitest"

/**
 * `/p/<token>` (B4, s227a): the route maps each lookup outcome to one answer.
 * `resolveView` / `renderView` are tested against real Postgres in business;
 * here they are mocked and the status codes, headers, the freeze gate, the
 * prefetch rule and the refusal pages' silence are pinned.
 */
const resolveView = vi.fn()
const renderView = vi.fn()
const recordView = vi.fn()
const loadServableWorkspace = vi.fn()
const checkApiRateLimit = vi.fn()
const resolveTenantSettings = vi.fn()
const contactDocumentVariables = vi.fn()
const error = vi.fn()

vi.mock("@chatbotx.io/business/page", async (importOriginal) => ({
  pageMessageHtml: (
    await importOriginal<typeof import("@chatbotx.io/business/page")>()
  ).pageMessageHtml,
  pageService: { resolveView, renderView, recordView },
}))
vi.mock("@chatbotx.io/business", () => ({ resolveTenantSettings }))
vi.mock("@chatbotx.io/variables", () => ({ contactDocumentVariables }))
vi.mock("@/lib/workspace/load-servable-workspace", () => ({
  loadServableWorkspace,
}))
vi.mock("@/lib/rate-limit/api-rate-limit", () => ({ checkApiRateLimit }))
vi.mock("@/lib/log", () => ({ logger: { error, warn: vi.fn() } }))
vi.mock("@/app/integrations/documenso/webhook/route", () => ({
  documensoWebhookRateLimitKey: () => "203.0.113.9",
}))

const TOKEN = "0123456789ABCDEFGHIJKL"
const view = {
  ok: true,
  link: { id: "71", workspaceId: "11", contactId: "31", contactInboxId: "41" },
  page: { id: "61", name: "Secret offer name", workspaceId: "11" },
}

const get = async (headers: Record<string, string> = {}, token = TOKEN) => {
  const { GET } = await import("@/app/p/[token]/route")
  return GET(new Request(`http://localhost/p/${token}`, { headers }), {
    params: Promise.resolve({ token }),
  })
}
const browser = {
  "user-agent": "Mozilla/5.0 (iPhone) AppleWebKit Safari",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
}

beforeEach(() => {
  vi.clearAllMocks()
  checkApiRateLimit.mockResolvedValue({ limited: false, retryAfter: 1 })
  loadServableWorkspace.mockResolvedValue({ servable: true })
  resolveTenantSettings.mockResolvedValue({ appUrl: "https://hub.example" })
  contactDocumentVariables.mockReturnValue("resolver")
  resolveView.mockResolvedValue(view)
  renderView.mockResolvedValue({
    html: "<!doctype html><p>Hi</p>",
    missing: [],
  })
})

test("a live link renders for its contact, counts the view, strict headers", async () => {
  const res = await get(browser)
  expect(res.status).toBe(200)
  expect(await res.text()).toBe("<!doctype html><p>Hi</p>")
  expect(renderView).toHaveBeenCalledWith({
    view,
    appUrl: "https://hub.example",
    resolveVariables: "resolver",
  })
  expect(contactDocumentVariables).toHaveBeenCalledWith("31")
  expect(recordView).toHaveBeenCalledWith({ linkId: "71" })
  expect(res.headers.get("cache-control")).toBe("private, no-store")
  expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow")
  expect(res.headers.get("referrer-policy")).toBe("no-referrer")
  expect(res.headers.get("x-content-type-options")).toBe("nosniff")
  const csp = res.headers.get("content-security-policy") ?? ""
  expect(csp).toContain("default-src 'none'")
  expect(csp).toContain("frame-ancestors 'none'")
  expect(csp).not.toContain("script-src")
})

test("a link preview renders but is not counted", async () => {
  const res = await get({ "user-agent": "facebookexternalhit/1.1 Facebot" })
  expect(res.status).toBe(200)
  expect(recordView).not.toHaveBeenCalled()
})

test.each([
  ["invalid", 404],
  ["not-found", 404],
  ["expired", 410],
  ["archived", 410],
])("%s is a %i page that names nothing", async (reason, status) => {
  resolveView.mockResolvedValue({ ok: false, reason })
  const res = await get(browser)
  expect(res.status).toBe(status)
  expect(res.headers.get("content-security-policy")).toContain(
    "default-src 'none'",
  )
  const body = await res.text()
  expect(body).not.toContain("Secret offer name")
  expect(renderView).not.toHaveBeenCalled()
  expect(recordView).not.toHaveBeenCalled()
})

test("a frozen workspace is a 410 before any render", async () => {
  loadServableWorkspace.mockResolvedValue({ servable: false })
  const res = await get(browser)
  expect(res.status).toBe(410)
  expect(loadServableWorkspace).toHaveBeenCalledWith("11")
  expect(renderView).not.toHaveBeenCalled()
})

test("the rate limit answers 429 before any lookup", async () => {
  checkApiRateLimit.mockResolvedValue({ limited: true, retryAfter: 7 })
  const res = await get(browser)
  expect(res.status).toBe(429)
  expect(res.headers.get("retry-after")).toBe("7")
  expect(checkApiRateLimit).toHaveBeenCalledWith({
    scope: "page-link-rate-limit",
    key: "203.0.113.9",
    limit: 60,
  })
  expect(resolveView).not.toHaveBeenCalled()
})

test("a render failure is a generic 503, logged without the full token", async () => {
  renderView.mockRejectedValue(new Error("stored document invalid"))
  const res = await get(browser)
  expect(res.status).toBe(503)
  expect(await res.text()).not.toContain("stored document invalid")
  expect(error).toHaveBeenCalledWith(
    expect.any(Error),
    "page link failed for token 0123...",
  )
})
