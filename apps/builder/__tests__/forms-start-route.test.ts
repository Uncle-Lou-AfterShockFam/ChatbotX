// @vitest-environment node

import { NextRequest } from "next/server"
import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * The web abandon beacon (s224a A2-4): the submit route's gates in the same
 * order, its OWN rate limit, a closed `{k}` body, and a bare 204 for every
 * well-formed request whether or not a visit opened (no oracle).
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
  start: vi.fn(),
  ipLimit: vi.fn(async () => ({ limited: false, retryAfter: 30 })),
  startLimit: vi.fn(async () => ({ limited: false, retryAfter: 30 })),
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
  formVisitService: { start: m.start },
}))
vi.mock("@/lib/rate-limit/form-rate-limit", () => ({
  checkFormStartIpRateLimit: m.ipLimit,
  checkFormStartFormRateLimit: m.startLimit,
}))
vi.mock("@/lib/rate-limit/guest-rate-limit", () => ({
  getGuestClientIp: () => "203.0.113.9",
}))
vi.mock("@/lib/log", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

const { POST, OPTIONS, startFormRequest } = await import(
  "../src/app/api/forms/[workspaceId]/[slug]/start/route"
)

const WS = "11701868563365888"
const V = "8f14e45f-ceea-4e67-a3b1-2c9e1d0a7b6f"
const URL_ = `https://chat.example/api/forms/${WS}/demo-intake/start`
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
  m.startLimit.mockResolvedValue({ limited: false, retryAfter: 30 })
  m.ipLimit.mockResolvedValue({ limited: false, retryAfter: 30 })
  m.start.mockResolvedValue({ kind: "started" })
})

describe("POST /api/forms/{ws}/{slug}/start", () => {
  test("a well-formed beacon is a bare 204 and hands the form + k to the service", async () => {
    const res = await post({ k: "sealed", v: V })
    expect(res.status).toBe(204)
    expect(await res.text()).toBe("")
    expect(m.start).toHaveBeenCalledWith({
      form: FORM,
      formLinkToken: "sealed",
      interactionId: V,
    })
  })

  test("an ignored beacon (bad link, closed form) answers the SAME 204", async () => {
    m.start.mockResolvedValue({ kind: "ignored", reason: "noLink" })
    const a = await post({ k: "garbage", v: V })
    m.start.mockResolvedValue({ kind: "ignored", reason: "closed" })
    const b = await post({ k: "sealed", v: V })
    expect([a.status, b.status]).toEqual([204, 204])
    expect(await a.text()).toBe(await b.text())
  })

  test("bad path, frozen workspace, scheduled deletion, unpublished form -> 404 before any write", async () => {
    expect((await post({ k: "x", v: V }, {}, "Bad Slug")).status).toBe(404)
    expect(
      (await post({ k: "x", v: V }, {}, "ok", "99999999999999999999")).status,
    ).toBe(404)
    m.servable.mockResolvedValueOnce({ servable: false, workspace: undefined })
    expect((await post({ k: "x", v: V })).status).toBe(404)
    m.scheduled.mockReturnValueOnce(true)
    expect((await post({ k: "x", v: V })).status).toBe(404)
    m.findPublishedBySlug.mockResolvedValueOnce(null)
    expect((await post({ k: "x", v: V })).status).toBe(404)
    expect(m.start).not.toHaveBeenCalled()
  })

  test("CORS: a stranger origin is 403; an embed origin is reflected", async () => {
    const stranger = await post(
      { k: "x", v: V },
      { origin: "https://evil.example" },
    )
    expect(stranger.status).toBe(403)
    expect(stranger.headers.get("access-control-allow-origin")).toBeNull()
    const embed = await post(
      { k: "x", v: V },
      { origin: "https://host.example" },
    )
    expect(embed.status).toBe(204)
    expect(embed.headers.get("access-control-allow-origin")).toBe(
      "https://host.example",
    )
    expect(m.start).toHaveBeenCalledTimes(1)
  })

  test("per-ip limit runs BEFORE any lookup: 429, no workspace or form query (Codex probe s224a)", async () => {
    m.ipLimit.mockResolvedValueOnce({ limited: true, retryAfter: 12.2 })
    const res = await post({ k: "x", v: V }, {}, "no-such-form")
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("13")
    expect(m.ipLimit).toHaveBeenCalledWith({ clientIp: "203.0.113.9" })
    expect(m.servable).not.toHaveBeenCalled()
    expect(m.findPublishedBySlug).not.toHaveBeenCalled()
    expect(m.start).not.toHaveBeenCalled()
  })

  test("per-form limit after the form resolved: 429, the service untouched", async () => {
    m.startLimit.mockResolvedValueOnce({ limited: true, retryAfter: 5 })
    const res = await post({ k: "x", v: V })
    expect(res.status).toBe(429)
    expect(m.startLimit).toHaveBeenCalledWith({ formId: "form-1" })
    expect(m.start).not.toHaveBeenCalled()
  })

  test("body: not JSON, missing k or v, bad v, empty k, unknown key, oversized (8 KiB) -> 400/413, no write", async () => {
    expect((await post("{nope")).status).toBe(400)
    expect((await post({})).status).toBe(400)
    expect((await post({ k: "x" })).status).toBe(400)
    expect((await post({ k: "x", v: "not-a-uuid" })).status).toBe(400)
    expect((await post({ k: "", v: V })).status).toBe(400)
    expect((await post({ k: "x", v: V, values: {} })).status).toBe(400)
    expect((await post({ k: "x".repeat(5000), v: V })).status).toBe(400)
    expect((await post({ k: "x".repeat(9000), v: V })).status).toBe(413)
    expect(
      (await post({ k: "x", v: V }, { "content-length": String(9 * 1024) }))
        .status,
    ).toBe(413)
    expect(m.start).not.toHaveBeenCalled()
  })

  test("a thrown error is a bare 500 with closed CORS, never its message", async () => {
    m.start.mockRejectedValueOnce(
      new Error('relation "FormVisit" secret detail'),
    )
    const res = await post({ k: "x", v: V }, { origin: "https://host.example" })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, errors: [] })
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("OPTIONS preflight answers 204", () => {
    const res = OPTIONS(
      new NextRequest(URL_, {
        method: "OPTIONS",
        headers: { origin: "https://host.example" },
      }),
    )
    expect(res.status).toBe(204)
  })

  test("startFormRequest is closed and fuzz-safe", () => {
    const junk: unknown[] = [
      null,
      1,
      "k",
      [],
      { k: 1 },
      { k: null },
      { K: "x" },
    ]
    for (let i = 0; i < 200; i++) {
      junk.push({
        k: Math.random()
          .toString(36)
          .repeat(i % 7),
        [`x${i}`]: i,
      })
    }
    for (const j of junk) {
      expect(() => startFormRequest.safeParse(j)).not.toThrow()
      expect(startFormRequest.safeParse(j).success).toBe(false)
    }
    expect(startFormRequest.safeParse({ k: "ok", v: V }).success).toBe(true)
  })
})
