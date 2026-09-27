// @vitest-environment node

import { NextRequest } from "next/server"
import { beforeEach, describe, expect, test, vi } from "vitest"

// s210: the guest route answers the widget iframe (the hub's own origin)
// only. A stranger's page relaying a server-minted token must get a 403 and
// no CORS grant, whatever token and parentOrigin it presents.
const HUB = "app.chatbotx.io"
const mocks = vi.hoisted(() => ({
  verify: vi.fn(async () => ({ authorized: true })),
  findWebchat: vi.fn(async () => ({
    inboxId: "inbox-1",
    authorizedDomains: ["shop.example"],
  })),
  findLatestBySource: vi.fn(async () => null),
  handleCreate: vi.fn(async () => ({ id: "m-1" })),
}))

vi.mock("@chatbotx.io/business", () => ({
  contactInboxService: { findLatestBySource: mocks.findLatestBySource },
  conversationService: { findBy: vi.fn() },
  isWorkspaceScheduledForDeletion: () => false,
  workspaceService: { find: vi.fn(async () => ({ id: "1" })) },
}))
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}))
vi.mock("@/features/integration-webchat/lib/webchat-access-token", () => ({
  verifyWebchatAccessToken: mocks.verify,
}))
vi.mock("@/features/integration-webchat/queries", () => ({
  findIntegrationWebchat: mocks.findWebchat,
}))
vi.mock("@/features/messages/actions/create-webchat-message.action", () => ({
  handleCreateWebchatMessage: mocks.handleCreate,
}))
vi.mock("@/features/messages/queries", () => ({ listMessages: vi.fn() }))
vi.mock("@/lib/domain", () => ({ getDomainFromHeader: async () => HUB }))
vi.mock("@/lib/rate-limit/guest-rate-limit", () => ({
  checkGuestRateLimit: async () => ({ limited: false }),
  getGuestClientIp: () => "192.0.2.1",
}))
vi.mock("@/lib/errors/server-handler", () => ({
  serverErrorHandler: (_e: unknown, headers: Headers) =>
    new Response(null, { status: 500, headers }),
}))

const { GET, POST, OPTIONS } = await import(
  "../src/app/api/guest/messages/route"
)
const GUEST = "123:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f"

const query = new URLSearchParams({
  workspaceId: "1",
  webchatId: "2",
  guestConversationId: GUEST,
  accessToken: "token",
})
const get = (origin?: string) =>
  new NextRequest(`https://${HUB}/api/guest/messages?${query}`, {
    headers: origin ? { origin } : {},
  })
const post = (origin: string | undefined, parentOrigin?: string) =>
  new NextRequest(`https://${HUB}/api/guest/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({
      workspaceId: "1",
      webchatId: "2",
      guestConversationId: GUEST,
      accessToken: "token",
      parentOrigin,
      text: "hello",
    }),
  })

beforeEach(() => {
  vi.clearAllMocks()
})

describe("guest messages route: hub origin only, no CORS (s210)", () => {
  test.each([
    "https://evil.example",
    "https://shop.example",
    "null",
    `https://${HUB}.evil.example`,
  ])("GET from Origin %s is 403 before any lookup", async (origin) => {
    const res = await GET(get(origin))
    expect(res.status).toBe(403)
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
    expect(mocks.verify).not.toHaveBeenCalled()
  })

  test("GET with no Origin (same-origin) or the hub's own Origin passes the gate", async () => {
    for (const origin of [undefined, `https://${HUB}`]) {
      const res = await GET(get(origin))
      expect(res.status).toBe(200)
      expect(res.headers.get("access-control-allow-origin")).toBeNull()
    }
    expect(mocks.findLatestBySource).toHaveBeenCalledTimes(2)
  })

  test("POST relayed from a stranger's page is 403 even with a valid token", async () => {
    const res = await POST(post("https://evil.example"))
    expect(res.status).toBe(403)
    expect(mocks.handleCreate).not.toHaveBeenCalled()
  })

  test("POST from the widget iframe (hub Origin, allowlisted parent) is served", async () => {
    const res = await POST(post(`https://${HUB}`, "shop.example"))
    expect(res.status).toBe(200)
    expect(mocks.handleCreate).toHaveBeenCalledTimes(1)
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("POST from the iframe for an off-allowlist parent is still 403", async () => {
    const res = await POST(post(`https://${HUB}`, "evil.example"))
    expect(res.status).toBe(403)
  })

  test("OPTIONS grants no cross-origin access", () => {
    const res = OPTIONS()
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
    expect(res.headers.get("access-control-allow-headers")).toBeNull()
  })
})
