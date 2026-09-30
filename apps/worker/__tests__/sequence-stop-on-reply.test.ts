import { beforeEach, describe, expect, test, vi } from "vitest"

const { mockRemove, mockWarn, mockInfo } = vi.hoisted(() => ({
  mockRemove: vi.fn(),
  mockWarn: vi.fn(),
  mockInfo: vi.fn(),
}))

vi.mock("@chatbotx.io/business/contact-sequence", () => ({
  contactSequenceService: { removeStopOnReplyEnrollments: mockRemove },
}))
vi.mock("../src/lib/logger", () => ({
  logger: { info: mockInfo, warn: mockWarn, error: vi.fn() },
}))

const { handleSequenceStopOnReply } = await import(
  "../src/events/message/handlers/sequence-stop-on-reply"
)

const base = {
  workspaceId: "ws-1",
  contactInboxId: "ci-1",
  channel: "api",
  inboxId: "inbox-1",
  occurredAt: new Date("2026-09-28T00:00:00Z"),
}

describe("handleSequenceStopOnReply", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRemove.mockResolvedValue(["seq-1"])
  })

  test("an outbound delivery echo (no origin) is ignored", async () => {
    await handleSequenceStopOnReply([{ ...base, contactId: "c-1" }])
    expect(mockRemove).not.toHaveBeenCalled()
  })

  test("an inbound reply ends the contact's stop-on-reply enrolments", async () => {
    await handleSequenceStopOnReply([
      { ...base, contactId: "c-1", origin: "inbound" },
    ])
    expect(mockRemove).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      contactId: "c-1",
      repliedAt: new Date("2026-09-28T00:00:00Z"),
      contactInboxId: "ci-1",
    })
    expect(mockInfo).toHaveBeenCalledTimes(1)
  })

  test("s226b: an out-of-office never ends an enrolment (it pauses instead)", async () => {
    await handleSequenceStopOnReply([
      { ...base, contactId: "c-1", origin: "inbound", autoReply: "ooo" },
    ])
    expect(mockRemove).not.toHaveBeenCalled()
  })

  test("each contact is handled once per batch, per workspace", async () => {
    await handleSequenceStopOnReply([
      { ...base, contactId: "c-1", origin: "inbound" },
      { ...base, contactId: "c-1", origin: "inbound" },
      { ...base, workspaceId: "ws-2", contactId: "c-1", origin: "inbound" },
    ])
    expect(mockRemove).toHaveBeenCalledTimes(2)
  })

  test("nothing ended logs nothing", async () => {
    mockRemove.mockResolvedValue([])
    await handleSequenceStopOnReply([
      { ...base, contactId: "c-1", origin: "inbound" },
    ])
    expect(mockInfo).not.toHaveBeenCalled()
  })

  test("a failure is logged and never blocks the rest of the batch", async () => {
    mockRemove.mockRejectedValueOnce(new Error("db down"))
    await handleSequenceStopOnReply([
      { ...base, contactId: "c-1", origin: "inbound" },
      { ...base, contactId: "c-2", origin: "inbound" },
    ])
    expect(mockWarn).toHaveBeenCalledTimes(1)
    expect(mockRemove).toHaveBeenCalledTimes(2)
  })

  test("an empty batch does nothing", async () => {
    await handleSequenceStopOnReply([])
    expect(mockRemove).not.toHaveBeenCalled()
  })
})
