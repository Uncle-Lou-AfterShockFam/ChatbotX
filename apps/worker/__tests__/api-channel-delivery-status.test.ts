import { beforeEach, describe, expect, test, vi } from "vitest"

// Drives `handleMessageStatus` with the shape the API channel's
// `handleMessageStatus` handler now returns (integrations/api). Before the
// fix the handler returned `contact: { sourceId: "" }`, which the worker
// refuses by design, so no API-channel status could ever reach a message.

const {
  mockBuildContext,
  mockEmit,
  mockFindBySourceId,
  mockFindContactInbox,
  mockIdentifyIntegration,
  mockRunChannelHandler,
} = vi.hoisted(() => ({
  mockBuildContext: vi.fn().mockResolvedValue({ workspaceId: "ws-1" }),
  mockEmit: vi.fn().mockResolvedValue(undefined),
  mockFindBySourceId: vi.fn(),
  mockFindContactInbox: vi.fn(),
  mockIdentifyIntegration: vi.fn(),
  mockRunChannelHandler: vi.fn(),
}))

vi.mock("@chatbotx.io/business", () => ({
  buildContext: mockBuildContext,
  contactInboxService: { findByUncached: mockFindContactInbox },
  conversationService: {
    findDMByContact: vi.fn(),
    markReadByContact: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  createMessageRepository: vi
    .fn()
    .mockResolvedValue({ findBySourceId: mockFindBySourceId }),
  getSafeSinceTime: vi.fn((date: Date | null) => date ?? new Date(0)),
  contactInboxRepository: {
    findWithConversationAndContact: mockFindContactInbox,
  },
}))

vi.mock("@chatbotx.io/event-bus", () => ({ emit: mockEmit }))

vi.mock("@chatbotx.io/sdk", () => ({
  SdkException: class SdkException extends Error {},
  resolveWithSourceUserIdFallback: async <T>(
    identity: { sourceId: string; sourceUserId?: string | null },
    lookup: (
      where: { sourceId: string } | { sourceUserId: string },
    ) => Promise<T | undefined>,
  ): Promise<T | undefined> => {
    const bySourceId = await lookup({ sourceId: identity.sourceId })
    if (bySourceId || !identity.sourceUserId) {
      return bySourceId
    }
    return await lookup({ sourceUserId: identity.sourceUserId })
  },
}))

vi.mock("@chatbotx.io/flow-config", () => ({
  messageEventTypeSchema: {
    enum: {
      "message:delivered": "message:delivered",
      "message:failed": "message:failed",
      "message:received": "message:received",
      "message:seen": "message:seen",
    },
  },
  UPDATE_STATUS_PAYLOAD_TYPE: "update_status",
}))

vi.mock("@chatbotx.io/worker-config", () => ({
  IntegrationJobAction: { messageStatus: "messageStatus" },
}))

vi.mock("../src/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock("../src/services/integrations", () => ({
  allIntegrations: { api: { runChannelHandler: mockRunChannelHandler } },
  integrationService: {
    identifyInboxAndIntegrationAuthFromIdentifier: mockIdentifyIntegration,
  },
}))

vi.mock("../src/integration/handlers/flow", () => ({
  runFlowPostback: vi.fn(),
}))

const { handleMessageStatus } = await import(
  "../src/integration/handlers/message-status"
)

const contactInbox = {
  id: "ci-1",
  contactId: "contact-1",
  inboxId: "inbox-1",
  sourceId: "+15550000001",
  lastMessageAt: null,
  conversation: { id: "conv-1", workspaceId: "ws-1" },
  contact: { id: "contact-1" },
}

const message = {
  id: "m-1",
  sourceId: "msg:57",
  conversationId: "conv-1",
  createdAt: new Date("2026-09-20T05:50:00.000Z"),
  contentAttributes: {},
}

const apiStatusJob = (
  status: "delivered" | "failed" | "read",
  contactSourceId: string,
  error?: unknown,
) => ({
  integrationType: "api",
  integrationIdentifier: "inbox-1",
  payload: {
    messageId: "msg:57",
    status,
    timestamp: "2026-09-20T05:50:06.000Z",
    error,
    contact: { sourceId: contactSourceId },
  },
})

describe("API channel delivery status reaches the message", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIdentifyIntegration.mockResolvedValue({
      inbox: { id: "inbox-1", workspaceId: "ws-1", channel: "api" },
      integrationRow: { id: "integration-1" },
    })
    mockFindContactInbox.mockImplementation(
      async ({ where }: { where: { sourceId?: string } }) =>
        where.sourceId === contactInbox.sourceId ? contactInbox : undefined,
    )
    mockFindBySourceId.mockResolvedValue(message)
    // What integrations/api `handleMessageStatus` returns after the fix.
    mockRunChannelHandler.mockImplementation(
      (_group: string, _name: string, { data }: { data: never }) => {
        const payload = (
          data as {
            payload: {
              messageId: string
              status: string
              contact: { sourceId: string }
            }
          }
        ).payload
        return {
          message: {
            sourceId: payload.messageId,
            messageType: "outgoing",
            contentType: "text",
            contentAttributes: { deliveryStatus: payload.status },
          },
          contact: { sourceId: payload.contact.sourceId },
          postbackAction: null,
          quickReplyAction: null,
          ref: null,
        }
      },
    )
  })

  test("delivered: finds the message by the callback messageId and emits message:delivered", async () => {
    await handleMessageStatus(
      apiStatusJob("delivered", "+15550000001") as never,
    )

    expect(mockFindContactInbox).toHaveBeenCalledWith({
      where: { inboxId: "inbox-1", sourceId: "+15550000001" },
    })
    expect(mockFindBySourceId).toHaveBeenCalledWith(
      "msg:57",
      "conv-1",
      "ws-1",
      expect.anything(),
    )
    expect(mockEmit).toHaveBeenCalledWith(
      "message:delivered",
      expect.objectContaining({
        action: expect.objectContaining({ messageId: "m-1" }),
        context: expect.objectContaining({ conversationId: "conv-1" }),
      }),
    )
  })

  test("failed: emits message:failed carrying the provider error, never retried", async () => {
    await handleMessageStatus(
      apiStatusJob("failed", "+15550000001", { reason: "stop-reply" }) as never,
    )

    expect(mockEmit).toHaveBeenCalledWith(
      "message:failed",
      expect.objectContaining({
        errorData: { reason: "stop-reply" },
        willRetry: false,
        action: expect.objectContaining({ messageId: "m-1" }),
      }),
    )
    expect(mockEmit).not.toHaveBeenCalledWith(
      "message:delivered",
      expect.anything(),
    )
  })

  test("read: accepted for a channel that reports reads (GV never does, iMessage may)", async () => {
    await handleMessageStatus(apiStatusJob("read", "+15550000001") as never)
    // The worker only reads epoch-shaped `read` timestamps; an ISO string
    // (what the API channel posts) falls back to the receive time.
    expect(mockEmit).toHaveBeenCalledWith(
      "message:seen",
      expect.objectContaining({ occurredAt: expect.any(Date) }),
    )
  })

  test("an empty recipient identity is refused, not attached to an empty-keyed row", async () => {
    await expect(
      handleMessageStatus(apiStatusJob("delivered", "") as never),
    ).rejects.toThrow("Unable to find conversation")
    expect(mockFindContactInbox).not.toHaveBeenCalled()
    expect(mockEmit).not.toHaveBeenCalled()
  })

  test("an unknown recipient on this inbox is refused", async () => {
    await expect(
      handleMessageStatus(apiStatusJob("delivered", "+15550009999") as never),
    ).rejects.toThrow("Unable to find conversation")
    expect(mockEmit).not.toHaveBeenCalled()
  })

  test("an unknown messageId still records the conversation-level event without a message", async () => {
    mockFindBySourceId.mockResolvedValue(null)
    await handleMessageStatus(
      apiStatusJob("delivered", "+15550000001") as never,
    )
    expect(mockEmit).toHaveBeenCalledWith(
      "message:delivered",
      expect.objectContaining({
        action: expect.objectContaining({ messageId: undefined }),
      }),
    )
  })
})
