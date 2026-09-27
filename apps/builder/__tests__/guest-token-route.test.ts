// @vitest-environment node

import { NextRequest } from "next/server"
import { beforeEach, describe, expect, test, vi } from "vitest"

const HUB = "app.chatbotx.io"
const mocks = vi.hoisted(() => ({
  refresh: vi.fn(async () => "fresh-token" as string | null),
  limited: { limited: false, retryAfter: 0 },
  rateLimit: vi.fn(),
}))

vi.mock("@chatbotx.io/business", () => ({
  integrationWebchatService: { findByIdForWorkspaceOrNull: vi.fn() },
  isWorkspaceScheduledForDeletion: () => false,
  workspaceService: { find: vi.fn() },
}))
vi.mock("@/features/integration-webchat/lib/refresh-webchat-token", () => ({
  refreshWebchatAccessToken: mocks.refresh,
}))
vi.mock("@/features/integration-webchat/lib/webchat-access-token", () => ({
  // "ours.<sig>" stands for a token this hub signed; anything else is junk.
  readWebchatAccessToken: async (token: string) =>
    token.startsWith("ours.") ? { exp: 0 } : null,
}))
vi.mock("@/lib/domain", () => ({ getDomainFromHeader: async () => HUB }))
vi.mock("@/lib/log", () => ({ logger: { warn: vi.fn() } }))
vi.mock("@/lib/rate-limit/guest-rate-limit", () => ({
  checkGuestRateLimit: (input: unknown) => {
    mocks.rateLimit(input)
    return Promise.resolve(mocks.limited)
  },
  getGuestClientIp: () => "192.0.2.1",
}))

const { POST } = await import("../src/app/api/guest/token/route")

const body = {
  workspaceId: "11701868563365888",
  webchatId: "42",
  guestConversationId: "123:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
  accessToken: "old-token",
  parentOrigin: "shop.example",
}
const post = (payload: unknown, origin: string | null = `https://${HUB}`) =>
  new NextRequest(`https://${HUB}/api/guest/token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.limited = { limited: false, retryAfter: 0 }
  mocks.refresh.mockResolvedValue("fresh-token")
})

describe("POST /api/guest/token (s210)", () => {
  test("the widget iframe gets a fresh token, never cached, no CORS", async () => {
    const res = await POST(post(body, `https://${HUB}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accessToken: "fresh-token" })
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
    expect(mocks.refresh).toHaveBeenCalledWith(
      expect.objectContaining({ appHost: HUB, parentOrigin: "shop.example" }),
      expect.any(Object),
    )
  })

  test.each([
    ["a stranger's page", "https://evil.example"],
    ["an opaque origin", "null"],
  ])("%s is refused before parsing", async (_, origin) => {
    const res = await POST(post(body, origin))
    expect(res.status).toBe(403)
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  test.each([
    ["not JSON", "{"],
    ["null", "null"],
    ["an unknown key", { ...body, originHost: "evil.example" }],
    ["a missing token", { ...body, accessToken: undefined }],
    ["an oversized token", { ...body, accessToken: "x".repeat(3000) }],
    ["a bad guest id", { ...body, guestConversationId: "guest" }],
  ])("%s is a 400", async (_, payload) => {
    const res = await POST(post(payload))
    expect(res.status).toBe(400)
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  test("rate limited: 429 with Retry-After", async () => {
    mocks.limited = { limited: true, retryAfter: 30 }
    const res = await POST(post(body))
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("30")
  })

  test("a refused refresh is a 403; a crash is a 500 with no token", async () => {
    mocks.refresh.mockResolvedValueOnce(null)
    expect((await POST(post(body))).status).toBe(403)
    mocks.refresh.mockRejectedValueOnce(new Error("db down"))
    const res = await POST(post(body))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ accessToken: null })
  })

  test("the session bucket is the signed token, never the body's guest id (s212)", async () => {
    // Junk tokens naming a victim's guest id must not touch its bucket.
    await POST(post(body))
    expect(mocks.rateLimit).toHaveBeenLastCalledWith(
      expect.objectContaining({ guestConversationId: undefined }),
    )
    await POST(post({ ...body, accessToken: "ours.sig-abc" }))
    expect(mocks.rateLimit).toHaveBeenLastCalledWith(
      expect.objectContaining({ guestConversationId: "sig-abc" }),
    )
  })

  test("no Origin is tolerated like /api/guest/messages (the token still gates)", async () => {
    const res = await POST(post(body, null))
    expect(res.status).toBe(200)
  })
})
