import { beforeEach, describe, expect, test, vi } from "vitest"

const { mockPause, mockWarn, mockInfo } = vi.hoisted(() => ({
  mockPause: vi.fn(),
  mockWarn: vi.fn(),
  mockInfo: vi.fn(),
}))

vi.mock("@chatbotx.io/business/contact-sequence", () => ({
  contactSequenceService: { pauseForAutoReply: mockPause },
}))
vi.mock("../src/lib/logger", () => ({
  logger: { info: mockInfo, warn: mockWarn, error: vi.fn() },
}))

const { handleSequenceOooPause } = await import(
  "../src/events/message/handlers/sequence-ooo-pause"
)

const base = {
  workspaceId: "ws-1",
  contactInboxId: "ci-1",
  channel: "api",
  inboxId: "inbox-1",
  occurredAt: new Date("2026-09-28T00:00:00Z"),
}

describe("handleSequenceOooPause (s226b)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPause.mockResolvedValue(["seq-1"])
  })

  test("an inbound out-of-office pauses the contact's enrolments", async () => {
    await handleSequenceOooPause([
      { ...base, contactId: "c-1", origin: "inbound", autoReply: "ooo" },
    ])
    expect(mockPause).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      contactId: "c-1",
      occurredAt: new Date("2026-09-28T00:00:00Z"),
    })
    expect(mockInfo).toHaveBeenCalledTimes(1)
  })

  test("a real reply, or a delivery echo, never pauses", async () => {
    await handleSequenceOooPause([
      { ...base, contactId: "c-1", origin: "inbound" },
      { ...base, contactId: "c-2", autoReply: "ooo" },
    ])
    expect(mockPause).not.toHaveBeenCalled()
  })

  test("once per contact per batch, per workspace; a failure never blocks the rest", async () => {
    mockPause.mockRejectedValueOnce(new Error("db down"))
    await handleSequenceOooPause([
      { ...base, contactId: "c-1", origin: "inbound", autoReply: "ooo" },
      { ...base, contactId: "c-1", origin: "inbound", autoReply: "ooo" },
      {
        ...base,
        workspaceId: "ws-2",
        contactId: "c-1",
        origin: "inbound",
        autoReply: "ooo",
      },
    ])
    expect(mockPause).toHaveBeenCalledTimes(2)
    expect(mockWarn).toHaveBeenCalledTimes(1)
  })
})
