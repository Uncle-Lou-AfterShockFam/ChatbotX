import { beforeEach, describe, expect, test, vi } from "vitest"

const { mockFindConversation, mockListInboxes, mockPick, mockRunFlowNode } =
  vi.hoisted(() => ({
    mockFindConversation: vi.fn(),
    mockListInboxes: vi.fn(),
    mockPick: vi.fn(),
    mockRunFlowNode: vi.fn(),
  }))

vi.mock("@chatbotx.io/business", () => ({
  conversationService: { findBy: mockFindConversation },
  contactInboxService: { listByContactId: mockListInboxes },
}))
vi.mock("@chatbotx.io/sequence-scheduler", () => ({
  getDispatchContactInboxes: mockPick,
}))
vi.mock("../src/integration/handlers/flow", () => ({
  runFlowNode: mockRunFlowNode,
}))
vi.mock("../src/integration/handlers/company-stop-guard", () => ({
  COMPANY_STOPPED: "company-stopped",
}))

const { sendFlowDirect } = await import(
  "../src/integration/handlers/send-flow-direct"
)

const base = {
  flowId: "flow-1",
  workspaceId: "ws-1",
  contactId: "c-1",
}
const gv = { id: "ci-gv" }
const email = { id: "ci-email" }

describe("sendFlowDirect: one run per sequence step (owner s220b)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindConversation.mockResolvedValue({ id: "conv-1" })
    mockListInboxes.mockResolvedValue([gv, email])
    mockRunFlowNode.mockResolvedValue(undefined)
    mockPick.mockResolvedValue([email])
  })

  test("runs the flow ONCE, on the dispatch's inbox only", async () => {
    await sendFlowDirect({ ...base, contactInboxId: "ci-gv" })
    expect(mockRunFlowNode).toHaveBeenCalledTimes(1)
    expect(mockRunFlowNode.mock.calls[0]?.[0]).toMatchObject({
      contactInboxId: gv,
    })
    expect(mockPick).not.toHaveBeenCalled()
  })

  test("a pinned inbox the contact no longer has falls back to the current pick", async () => {
    await sendFlowDirect({ ...base, contactInboxId: "ci-gone" })
    expect(mockRunFlowNode).toHaveBeenCalledTimes(1)
    expect(mockRunFlowNode.mock.calls[0]?.[0]).toMatchObject({
      contactInboxId: email,
    })
  })

  test("no inbox at all runs nothing and is not a company stop", async () => {
    mockListInboxes.mockResolvedValue([])
    mockPick.mockResolvedValue([])
    expect(
      await sendFlowDirect({ ...base, contactInboxId: "ci-gone" }),
    ).toEqual({ companyStopped: false })
    expect(mockRunFlowNode).not.toHaveBeenCalled()
  })

  test("a company-stopped run reports companyStopped", async () => {
    mockRunFlowNode.mockResolvedValue("company-stopped")
    expect(await sendFlowDirect({ ...base, contactInboxId: "ci-gv" })).toEqual({
      companyStopped: true,
    })
  })

  test("a contact without a conversation still throws", async () => {
    mockFindConversation.mockResolvedValue(undefined)
    await expect(
      sendFlowDirect({ ...base, contactInboxId: "ci-gv" }),
    ).rejects.toThrow("Conversation not found")
  })
})
