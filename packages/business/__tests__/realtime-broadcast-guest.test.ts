import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  low: vi.fn(async () => undefined),
  warn: vi.fn(),
}))

vi.mock("@chatbotx.io/partysocket-config", () => ({
  broadcastToGuestParty: mocks.low,
  broadcastToWorkspaceParty: vi.fn(),
  revokeWorkspaceMemberConnections: vi.fn(),
  sendToWorkspaceMember: vi.fn(),
}))
vi.mock("../src/platform/settings", () => ({
  resolveTenantSettings: async () => ({ wsUrl: "ws://realtime.test" }),
  resolveBroadcastSecret: () => "s".repeat(32),
}))
vi.mock("../src/logger", () => ({ logger: { warn: mocks.warn } }))

const { broadcastToGuestParty } = await import(
  "../src/platform/realtime-broadcast"
)

const WS = "11701868563365888"
const MINTED = `${WS}:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f`
const event = { eventType: "messageCreated", data: {} } as never

beforeEach(() => {
  vi.clearAllMocks()
})

describe("broadcastToGuestParty (s213)", () => {
  test("delivers to a minted guest id of the same workspace", async () => {
    await broadcastToGuestParty(
      { workspaceId: WS, guestConversationId: MINTED },
      event,
    )
    expect(mocks.low).toHaveBeenCalledWith(
      { url: "ws://realtime.test", secret: "s".repeat(32) },
      MINTED,
      event,
    )
    expect(mocks.warn).not.toHaveBeenCalled()
  })

  test.each([
    ["a digits-only sourceId (API / passive upsert)", "11709523831537664"],
    [
      "another workspace's minted id (CSV import)",
      "9:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
    ],
    ["a path-shaped sourceId", `../workspaces/${WS}`],
    ["an empty sourceId", ""],
  ])("skips %s with a warning, never broadcasting", async (_, sourceId) => {
    await broadcastToGuestParty(
      { workspaceId: WS, guestConversationId: sourceId },
      event,
    )
    expect(mocks.low).not.toHaveBeenCalled()
    expect(mocks.warn).toHaveBeenCalledTimes(1)
  })
})
