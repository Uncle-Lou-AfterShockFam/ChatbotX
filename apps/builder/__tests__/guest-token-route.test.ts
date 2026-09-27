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
  // "ours.<sig>" stands for a token this hub signed (session "sid-1"),
  // "legacy.<sig>" for one signed before the sid claim; anything else is junk.
  readWebchatAccessToken: (token: string) => {
    const signed = { exp: 0, webchatId: "42", workspaceId: "11701868563365888" }
    if (token.startsWith("ours.")) {
      return Promise.resolve({ ...signed, sid: "sid-1" })
    }
    if (token.startsWith("legacy.")) {
      return Promise.resolve({ ...signed, sid: null })
    }
    return Promise.resolve(null)
  },
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
  guestConversationId: "11701868563365888:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
  accessToken: "ours.old-sig",
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
    [
      "a legacy digits-only guest id (s213)",
      { ...body, guestConversationId: "11616773281153025" },
    ],
    [
      "another workspace's guest id (s213)",
      {
        ...body,
        guestConversationId: "9:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
      },
    ],
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

  test("junk, or a token for another webchat, is refused before any rate-limit key or lookup (s212)", async () => {
    for (const payload of [
      { ...body, accessToken: "forged.sig" },
      { ...body, webchatId: "43" },
      // The guest id moves with the workspace, so the parse passes and the
      // token (signed for the other workspace) is what refuses it.
      {
        ...body,
        workspaceId: "11701868563365889",
        guestConversationId:
          "11701868563365889:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
      },
    ]) {
      const res = await POST(post(payload))
      expect(res.status).toBe(403)
    }
    expect(mocks.rateLimit).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  test("both buckets key on signed fields: the session survives refreshes, never the body's guest id (s212)", async () => {
    await POST(
      post({
        ...body,
        guestConversationId:
          "11701868563365888:9f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
      }),
    )
    expect(mocks.rateLimit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        guestConversationId: "sid-1",
        webchatId: "42",
      }),
    )
    await POST(post({ ...body, accessToken: "legacy.sig-abc" }))
    expect(mocks.rateLimit).toHaveBeenLastCalledWith(
      expect.objectContaining({ guestConversationId: "sig-abc" }),
    )
  })

  test("no Origin is tolerated like /api/guest/messages (the token still gates)", async () => {
    const res = await POST(post(body, null))
    expect(res.status).toBe(200)
  })
})
