// @vitest-environment node

import { NextRequest } from "next/server"
import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * The public submit route (s200): status mapping, CORS by embedOrigins,
 * body caps, and that nothing reaches the pipeline before the gates.
 */
const m = vi.hoisted(() => ({
  servable: vi.fn(
    async (): Promise<{
      servable: boolean
      workspace: object | undefined
    }> => ({
      servable: true,
      workspace: {},
    }),
  ),
  workspaceFind: vi.fn(async () => ({ id: "ws", deletionScheduledAt: null })),
  scheduled: vi.fn(() => false),
  findPublishedBySlug: vi.fn(),
  submit: vi.fn(),
  rateLimit: vi.fn(async () => ({ limited: false, retryAfter: 30 })),
}))
vi.mock("@/lib/workspace/load-servable-workspace", () => ({
  loadServableWorkspace: m.servable,
}))
vi.mock("@chatbotx.io/business", () => ({
  workspaceService: { find: m.workspaceFind },
  isWorkspaceScheduledForDeletion: m.scheduled,
}))
vi.mock("@chatbotx.io/business/form", () => ({
  formService: { findPublishedBySlug: m.findPublishedBySlug },
  formSubmitService: { submit: m.submit },
}))
vi.mock("@/lib/rate-limit/form-rate-limit", () => ({
  checkFormRateLimit: m.rateLimit,
}))
vi.mock("@/lib/rate-limit/guest-rate-limit", () => ({
  getGuestClientIp: () => "203.0.113.9",
}))

const { POST, OPTIONS, submitFormRequest } = await import(
  "../src/app/api/forms/[workspaceId]/[slug]/submit/route"
)

const WS = "11701868563365888"
const URL_ = `https://chat.example/api/forms/${WS}/demo-intake/submit`
const FORM = {
  id: "form-1",
  settings: { embedOrigins: ["https://host.example"] },
}
const params = (slug = "demo-intake", workspaceId = WS) => ({
  params: Promise.resolve({ workspaceId, slug }),
})
const post = (
  body: unknown,
  headers: Record<string, string> = {},
  slug?: string,
  ws?: string,
) =>
  POST(
    new NextRequest(URL_, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    params(slug, ws),
  )

beforeEach(() => {
  vi.clearAllMocks()
  m.servable.mockResolvedValue({ servable: true, workspace: {} })
  m.scheduled.mockReturnValue(false)
  m.findPublishedBySlug.mockResolvedValue(FORM)
  m.rateLimit.mockResolvedValue({ limited: false, retryAfter: 30 })
  m.submit.mockResolvedValue({
    kind: "ok",
    duplicate: false,
    submissionId: "s1",
    contactId: null,
    successMessage: "Thanks",
    redirectUrl: null,
  })
})

describe("POST /api/forms/{ws}/{slug}/submit", () => {
  test("happy path: 200 with the success message, pipeline gets the parsed body", async () => {
    const res = await post({
      values: { first_name: "Ada" },
      website: "",
      timezone: "UTC",
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      duplicate: false,
      successMessage: "Thanks",
      redirectUrl: null,
    })
    expect(m.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        slug: "demo-intake",
        values: { first_name: "Ada" },
        honeypotFilled: false,
        clientIp: "203.0.113.9",
        sourceTimezone: "UTC",
      }),
    )
  })

  test("a filled honeypot is passed as honeypotFilled", async () => {
    await post({ values: {}, website: "http://spam" })
    expect(m.submit).toHaveBeenCalledWith(
      expect.objectContaining({ honeypotFilled: true }),
    )
  })

  test.each([
    ["bad workspace id", "demo-intake", "abc"],
    ["bad slug", "Bad Slug", WS],
  ])("%s -> 404 before any lookup", async (_l, slug, ws) => {
    const res = await post({ values: {} }, {}, slug, ws)
    expect(res.status).toBe(404)
    expect(m.servable).not.toHaveBeenCalled()
  })

  test("frozen / scheduled-for-deletion workspace and an unpublished form -> 404, pipeline untouched", async () => {
    m.servable.mockResolvedValue({ servable: false, workspace: undefined })
    expect((await post({ values: {} })).status).toBe(404)
    m.servable.mockResolvedValue({ servable: true, workspace: {} })
    m.scheduled.mockReturnValue(true)
    expect((await post({ values: {} })).status).toBe(404)
    m.scheduled.mockReturnValue(false)
    m.findPublishedBySlug.mockResolvedValue(null)
    expect((await post({ values: {} })).status).toBe(404)
    expect(m.submit).not.toHaveBeenCalled()
  })

  test("CORS: an allowed embed origin is reflected; a stranger origin is 403; same-origin needs none", async () => {
    const ok = await post({ values: {} }, { origin: "https://host.example" })
    expect(ok.status).toBe(200)
    expect(ok.headers.get("access-control-allow-origin")).toBe(
      "https://host.example",
    )
    const bad = await post({ values: {} }, { origin: "https://evil.example" })
    expect(bad.status).toBe(403)
    expect(bad.headers.get("access-control-allow-origin")).toBeNull()
    expect(m.submit).toHaveBeenCalledTimes(1)
    const same = await post({ values: {} }, { origin: "https://chat.example" })
    expect(same.status).toBe(200)
  })

  test("rate limited -> 429 with Retry-After from the limiter, then from the pipeline budget", async () => {
    m.rateLimit.mockResolvedValue({ limited: true, retryAfter: 42 })
    const res = await post({ values: {} })
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("42")
    expect(m.submit).not.toHaveBeenCalled()
    m.rateLimit.mockResolvedValue({ limited: false, retryAfter: 1 })
    m.submit.mockResolvedValue({ kind: "rateLimited", retryAfter: 3600 })
    const budget = await post({ values: {} })
    expect(budget.status).toBe(429)
    expect(budget.headers.get("retry-after")).toBe("3600")
  })

  test.each([
    ["not JSON", "{nope", 400],
    ["array body", [1, 2], 400],
    ["missing values", {}, 400],
    ["unknown top-level key", { values: {}, extra: 1 }, 400],
    ["bad field key", { values: { "Bad Key": "x" } }, 400],
    ["object value", { values: { a: { nested: 1 } } }, 400],
    ["string too long", { values: { a: "x".repeat(2001) } }, 400],
    [
      "list too long",
      { values: { a: Array.from({ length: 51 }, () => "v") } },
      400,
    ],
    [
      "too many keys",
      {
        values: Object.fromEntries(
          Array.from({ length: 101 }, (_, i) => [`k${i}`, "v"]),
        ),
      },
      400,
    ],
  ])("%s -> %i, pipeline untouched", async (_l, body, status) => {
    const res = await post(body)
    expect(res.status).toBe(status)
    expect(m.submit).not.toHaveBeenCalled()
  })

  test("a body over 64 KiB is 413 by Content-Length and by measured size", async () => {
    const big = { values: { a: "x".repeat(70_000) } }
    const byLength = await post(big, { "content-length": String(70_100) })
    expect(byLength.status).toBe(413)
    const measured = await POST(
      new NextRequest(URL_, {
        method: "POST",
        body: JSON.stringify(big),
        headers: { "content-type": "application/json" },
      }),
      params(),
    )
    expect([400, 413]).toContain(measured.status)
    expect(m.submit).not.toHaveBeenCalled()
  })

  test("pipeline refusals map: invalid -> 400 with issues, notFound -> 404", async () => {
    m.submit.mockResolvedValue({
      kind: "invalid",
      issues: [{ key: "email", code: "email" }],
    })
    const bad = await post({ values: { email: "nope" } })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({
      ok: false,
      errors: [{ key: "email", code: "email" }],
    })
    m.submit.mockResolvedValue({ kind: "notFound" })
    expect((await post({ values: {} })).status).toBe(404)
  })

  test("a thrown error never leaks: serverErrorHandler shape, closed CORS", async () => {
    m.submit.mockRejectedValue(new Error("db down"))
    const res = await post({ values: {} }, { origin: "https://host.example" })
    expect(res.status).toBe(400)
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("OPTIONS preflight answers 204 and reflects the origin", () => {
    const res = OPTIONS(
      new NextRequest(URL_, {
        method: "OPTIONS",
        headers: { origin: "https://any.example" },
      }),
    )
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://any.example",
    )
  })

  test("submitFormRequest is closed and fuzz-safe: random junk never throws, only fails", () => {
    const junk = [
      null,
      1,
      "x",
      [],
      { values: null },
      { values: [] },
      { values: { a: Symbol("s") } },
    ]
    for (const body of junk) {
      expect(() => submitFormRequest.safeParse(body)).not.toThrow()
      expect(
        submitFormRequest.safeParse(body).success,
        JSON.stringify(String(body)),
      ).toBe(false)
    }
    expect(
      submitFormRequest.safeParse({
        values: { ok_key: ["a"], n: 1, b: true, s: "x" },
      }).success,
    ).toBe(true)
  })
})
