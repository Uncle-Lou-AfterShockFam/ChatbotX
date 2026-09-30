// @vitest-environment node

import { signGuestSecret } from "@chatbotx.io/partysocket-config/guest-secret"
import { beforeEach, describe, expect, test, vi } from "vitest"

const {
  insertBuilder,
  mockAutomatedResponseEnqueue,
  mockAutomatedResponseEnqueueFlowAction,
  mockChatQueueAdd,
  mockContactFindById,
  mockContactUnblockIfBlocked,
  mockContactInboxFindLatest,
  mockContactInboxUpdateTracking,
  mockConversationEnsureActive,
  mockConversationFindBy,
  mockCreateMessageRepository,
  mockCreateNewContactWithMac,
  mockDbUpdate,
  mockEmit,
  mockEmitContactCreated,
  mockFindOrFail,
  mockIntegrationQueueAdd,
  mockQuotaIncrement,
  mockCheckGuestRateLimit,
  mockCheckGuestCreateRateLimit,
  mockVerifyWebchatAccessToken,
  mockRepositoryCreate,
  mockWorkspaceFind,
  tx,
  updateBuilder,
} = vi.hoisted(() => {
  const updateBuilder = {
    set: vi.fn(),
    where: vi.fn(),
  }
  updateBuilder.set.mockReturnValue(updateBuilder)
  updateBuilder.where.mockResolvedValue(undefined)

  const insertBuilder = {
    values: vi.fn(),
    returning: vi.fn(),
  }
  insertBuilder.values.mockReturnValue(insertBuilder)

  // The transaction handed to the `createNewContactWithMac` create callback.
  const tx = {
    insert: vi.fn().mockReturnValue(insertBuilder),
  }

  const mockRepositoryCreate = vi.fn()

  return {
    insertBuilder,
    mockAutomatedResponseEnqueue: vi.fn().mockResolvedValue(undefined),
    mockAutomatedResponseEnqueueFlowAction: vi
      .fn()
      .mockResolvedValue(undefined),
    mockContactFindById: vi.fn(),
    mockContactUnblockIfBlocked: vi.fn().mockResolvedValue(null),
    mockContactInboxFindLatest: vi.fn(),
    mockContactInboxUpdateTracking: vi.fn().mockResolvedValue(null),
    mockConversationFindBy: vi.fn(),
    mockChatQueueAdd: vi.fn().mockResolvedValue(undefined),
    mockConversationEnsureActive: vi.fn().mockResolvedValue(false),
    mockCreateMessageRepository: vi.fn().mockResolvedValue({
      create: mockRepositoryCreate,
      createWithAttachments: vi.fn(),
    }),
    // Default: behave like an under-limit owner — run the create callback in
    // the fake transaction and report success.
    mockCreateNewContactWithMac: vi.fn(
      async (args: {
        create: (tx: unknown) => Promise<{ value: unknown }>
      }): Promise<
        { ok: true; value: unknown } | { ok: false; level: string }
      > => {
        const created = await args.create(tx)
        return { ok: true, value: created.value }
      },
    ),
    mockDbUpdate: vi.fn().mockReturnValue(updateBuilder),
    mockEmit: vi.fn(),
    mockEmitContactCreated: vi.fn().mockResolvedValue(undefined),
    mockFindOrFail: vi.fn(),
    mockIntegrationQueueAdd: vi.fn().mockResolvedValue(undefined),
    mockQuotaIncrement: vi.fn().mockResolvedValue(undefined),
    mockCheckGuestCreateRateLimit: vi.fn(),
    mockCheckGuestRateLimit: vi
      .fn()
      .mockResolvedValue({ limited: false, retryAfter: 10 }),
    mockVerifyWebchatAccessToken: vi.fn().mockResolvedValue({
      authorized: true,
      guestConversationId: "workspace-1:guest-1",
    }),
    mockRepositoryCreate,
    mockWorkspaceFind: vi.fn().mockResolvedValue({ ownerId: "owner-1" }),
    tx,
    updateBuilder,
  }
})

vi.mock("@/lib/safe-action", () => ({
  actionClient: {
    inputSchema: vi.fn(() => ({
      action: vi.fn(),
    })),
  },
}))

vi.mock("@chatbotx.io/automated-response", () => ({
  automatedResponseService: {
    enqueue: mockAutomatedResponseEnqueue,
    enqueueFlowAction: mockAutomatedResponseEnqueueFlowAction,
  },
}))

vi.mock("@chatbotx.io/business", () => ({
  isWorkspaceScheduledForDeletion: (
    workspace:
      | { scheduledDeletionAt?: Date | string | null }
      | null
      | undefined,
  ) => Boolean(workspace?.scheduledDeletionAt),
  contactInboxService: {
    findLatestBySource: mockContactInboxFindLatest,
    updateTracking: mockContactInboxUpdateTracking,
  },
  contactService: {
    findById: mockContactFindById,
    unblockIfBlocked: mockContactUnblockIfBlocked,
  },
  conversationService: {
    ensureActive: mockConversationEnsureActive,
    findBy: mockConversationFindBy,
  },
  quotaEnforcementService: {
    increment: mockQuotaIncrement,
    createNewContactWithMac: mockCreateNewContactWithMac,
  },
  resolveTenantSettings: vi
    .fn()
    .mockResolvedValue({ storageUrl: "https://storage.example.com" }),
  workspaceService: { find: mockWorkspaceFind },
  messageCleanupService: {
    cancelByInboxSource: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock("@/lib/log", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock("@/lib/rate-limit/guest-rate-limit", () => ({
  checkGuestCreateRateLimit: mockCheckGuestCreateRateLimit,
  checkGuestRateLimit: mockCheckGuestRateLimit,
  getGuestClientIp: vi.fn(() => "192.0.2.1"),
}))

vi.mock("@/features/integration-webchat/lib/webchat-access-token", () => ({
  verifyWebchatAccessToken: mockVerifyWebchatAccessToken,
}))

// The real (pure) allowlist module; the hub host comes from the proxy header.
const appHost = vi.hoisted(() => ({ current: "app.chatbotx.io" }))
vi.mock("@/lib/domain", () => ({
  getDomainFromHeader: vi.fn(async () => appHost.current),
}))

vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn((namespace?: string) => {
    const messages: Record<string, string> = {
      "webchat.rateLimitExceeded":
        "Too many requests. Please try again in a moment.",
      "webchat.unauthorizedDomain.description":
        "This website is not authorized to load this chat widget.",
    }

    return Promise.resolve(
      (key: string) => messages[namespace ? `${namespace}.${key}` : key] ?? key,
    )
  }),
}))

vi.mock("@chatbotx.io/business/errors", () => ({
  ChatbotXException: class ChatbotXException extends Error {
    code: string
    httpStatusCode: number
    constructor(message: string, code = "systemError", httpStatusCode = 400) {
      super(message)
      this.code = code
      this.httpStatusCode = httpStatusCode
    }
  },
}))

vi.mock("@chatbotx.io/business/utils", () => ({
  getPublicFileUrl: vi.fn((path: string, base: string) => `${base}/${path}`),
}))

vi.mock("@chatbotx.io/database/client", () => ({
  db: {
    update: mockDbUpdate,
  },
  eq: vi.fn((col: unknown, val: unknown) => ({ __eq: [col, val] })),
  findOrFail: mockFindOrFail,
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  })),
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  createMessageRepository: mockCreateMessageRepository,
}))

vi.mock("@chatbotx.io/database/schema", () => ({
  contactInboxModel: {
    id: "contactInboxId",
    firstInteractionAt: "firstInteractionAt",
  },
  contactModel: { id: "contactId" },
  conversationModel: { id: "conversationId" },
  integrationWebchatModel: { id: "integrationWebchatId" },
}))

vi.mock("@chatbotx.io/event-bus", () => ({
  emit: mockEmit,
}))

vi.mock("@chatbotx.io/events", () => ({
  emitContactCreated: mockEmitContactCreated,
}))

vi.mock("@chatbotx.io/filesystem", () => ({
  uploadMultipleFiles: vi.fn(),
}))

vi.mock("@chatbotx.io/flow-config", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@chatbotx.io/flow-config")>()
  return {
    ...actual,
    messageEventTypeSchema: {
      enum: { "message:received": "message:received" },
    },
  }
})

vi.mock("@chatbotx.io/partysocket-config", () => ({
  RealtimeEventType: { messageCreated: "messageCreated" },
}))

vi.mock("@chatbotx.io/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chatbotx.io/utils")>()
  return { ...actual, createId: vi.fn(() => "generated-id") }
})

vi.mock("@chatbotx.io/worker-config", () => ({
  ChatJobAction: { broadcastEvent: "broadcastEvent" },
  chatQueue: { add: mockChatQueueAdd },
  IntegrationJobAction: {
    runChallenge: "runChallenge",
    runFlowPostback: "runFlowPostback",
    runRef: "runRef",
    sendFlow: "sendFlow",
  },
  integrationQueue: { add: mockIntegrationQueueAdd },
}))

const { handleCreateWebchatMessage } = await import(
  "../src/features/messages/actions/create-webchat-message.action"
)

// s215: the credential is the secret minted with the id, under the test env's
// broadcast secret (vitest-config setup-env).
const GUEST_SECRET = await signGuestSecret(
  "1:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
  process.env.REALTIME_BROADCAST_SECRET as string,
)

const conversation = {
  id: "conv-1",
  workspaceId: "1",
  contactId: "contact-1",
  additionalAttributes: null,
}
const contactInbox = {
  id: "ci-1",
  inboxId: "inbox-1",
  contactId: "contact-1",
  sourceId: "guest-1",
  source: "webchat",
  channel: "webchat",
}
const contact = {
  id: "contact-1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
}

const resetCommonMocks = () => {
  vi.clearAllMocks()
  updateBuilder.set.mockReturnValue(updateBuilder)
  updateBuilder.where.mockResolvedValue(undefined)
  mockDbUpdate.mockReturnValue(updateBuilder)
  mockFindOrFail.mockResolvedValue({
    inboxId: "inbox-1",
    authorizedDomains: [],
    persistentMenus: [],
  })
  mockConversationFindBy.mockResolvedValue(conversation)
  mockContactFindById.mockResolvedValue(contact)
  mockContactUnblockIfBlocked.mockResolvedValue(null)
  mockRepositoryCreate.mockImplementation((input) =>
    Promise.resolve({
      id: "msg-1",
      ...input,
      sourceId: null,
      updatedAt: input.createdAt,
    }),
  )
  mockCreateMessageRepository.mockResolvedValue({
    create: mockRepositoryCreate,
    createWithAttachments: vi.fn(),
  })
  mockChatQueueAdd.mockResolvedValue(undefined)
  tx.insert.mockReturnValue(insertBuilder)
  insertBuilder.values.mockReturnValue(insertBuilder)
  insertBuilder.returning.mockReset()
  mockQuotaIncrement.mockResolvedValue(undefined)
  mockCheckGuestRateLimit.mockResolvedValue({ limited: false, retryAfter: 10 })
  mockCheckGuestCreateRateLimit.mockResolvedValue({
    limited: false,
    retryAfter: 60,
  })
  mockVerifyWebchatAccessToken.mockResolvedValue({
    authorized: true,
  })
  mockWorkspaceFind.mockResolvedValue({ ownerId: "owner-1" })
  mockCreateNewContactWithMac.mockImplementation(
    async (args: { create: (tx: unknown) => Promise<{ value: unknown }> }) => {
      const created = await args.create(tx)
      return { ok: true, value: created.value }
    },
  )
}

describe("handleCreateWebchatMessage", () => {
  beforeEach(() => {
    resetCommonMocks()
    mockContactInboxFindLatest.mockResolvedValue(contactInbox)
  })

  test("updates conversation read and activity timestamps from the created webchat message", async () => {
    await handleCreateWebchatMessage({
      parsedInput: {
        text: "hello",
        workspaceId: "1",
        webchatId: "webchat-1",
        guestConversationId: "1:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
        guestSecret: GUEST_SECRET,
      },
    })

    const messageInput = mockRepositoryCreate.mock.calls[0]?.[0] as {
      createdAt: Date
    }
    expect(updateBuilder.set).toHaveBeenNthCalledWith(1, {
      contactLastReadAt: messageInput.createdAt,
      lastActivityAt: messageInput.createdAt,
      contactRepliedAt: messageInput.createdAt,
    })
  })

  test("rejects messages when the workspace is scheduled for deletion", async () => {
    mockWorkspaceFind.mockResolvedValue({
      id: "1",
      ownerId: "owner-1",
      scheduledDeletionAt: new Date(),
    })

    await expect(
      handleCreateWebchatMessage({
        parsedInput: {
          text: "hello",
          workspaceId: "1",
          webchatId: "webchat-1",
          guestConversationId: "1:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
          guestSecret: GUEST_SECRET,
        },
      }),
    ).rejects.toMatchObject({
      code: "workspaceScheduledDeletion",
    })

    expect(mockVerifyWebchatAccessToken).not.toHaveBeenCalled()
  })

  test("updates webchat contact inbox message, incoming message, and read timestamps", async () => {
    await handleCreateWebchatMessage({
      parsedInput: {
        text: "hello",
        workspaceId: "1",
        webchatId: "webchat-1",
        guestConversationId: "1:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
        guestSecret: GUEST_SECRET,
      },
    })

    const messageInput = mockRepositoryCreate.mock.calls[0]?.[0] as {
      createdAt: Date
    }
    expect(mockContactInboxUpdateTracking).toHaveBeenCalledWith({
      contactInboxId: "ci-1",
      contactId: "contact-1",
      workspaceId: "1",
      data: {
        firstInteractionAt: messageInput.createdAt,
        contactLastReadAt: messageInput.createdAt,
        lastMessageAt: messageInput.createdAt,
        lastIncomingMessageAt: messageInput.createdAt,
        lastUserInput: "hello",
        lastUserInputType: "text",
      },
    })
  })

  test("auto-unblocks using the resolved contact row after creating an inbound message", async () => {
    await handleCreateWebchatMessage({
      parsedInput: {
        text: "hello",
        workspaceId: "1",
        webchatId: "webchat-1",
        guestConversationId: "1:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
        guestSecret: GUEST_SECRET,
      },
    })

    expect(mockContactUnblockIfBlocked).toHaveBeenCalledWith(
      { workspaceId: "1", id: "contact-1" },
      contact,
    )
  })

  test("enqueues automated response with workspace context for active text messages", async () => {
    mockConversationEnsureActive.mockResolvedValue(true)

    await handleCreateWebchatMessage({
      parsedInput: {
        text: "hello",
        workspaceId: "1",
        webchatId: "webchat-1",
        guestConversationId: "1:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
        guestSecret: GUEST_SECRET,
      },
    })

    expect(mockAutomatedResponseEnqueue).toHaveBeenCalledWith({
      conversationId: "conv-1",
      contactInboxId: "ci-1",
      messageId: "msg-1",
      messageText: "hello",
      workspaceId: "1",
    })
  })

  describe("pending challenge (s230a)", () => {
    const challenge = {
      type: "step",
      data: { flowId: "flow-1", nodeId: "node-1", stepId: "step-1" },
    }
    const send = (text: string) =>
      handleCreateWebchatMessage({
        parsedInput: {
          text,
          workspaceId: "1",
          webchatId: "webchat-1",
          guestConversationId: "1:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
          guestSecret: GUEST_SECRET,
        },
      })
    const challengeCalls = () =>
      mockIntegrationQueueAdd.mock.calls.filter(
        ([name]) => name === "runChallenge",
      )

    beforeEach(() => {
      mockConversationFindBy.mockResolvedValue({
        ...conversation,
        additionalAttributes: { challenge },
      })
    })

    test("keys the challenge run on the reply: ids, messageId, createdAt and a per-message jobId", async () => {
      await send("my answer")

      const messageInput = mockRepositoryCreate.mock.calls[0]?.[0] as {
        createdAt: Date
      }
      expect(challengeCalls()).toEqual([
        [
          "runChallenge",
          {
            type: "runChallenge",
            data: {
              conversationId: "conv-1",
              contactInboxId: "ci-1",
              messageId: "msg-1",
              messageCreatedAt: messageInput.createdAt,
              challenge,
            },
          },
          { jobId: "step-challenge-conv-1-msg-1" },
        ],
      ])
      expect(mockAutomatedResponseEnqueue).not.toHaveBeenCalled()
    })

    test("a second reply is its own job, never deduplicated into the first", async () => {
      mockRepositoryCreate
        .mockImplementationOnce((input) =>
          Promise.resolve({ id: "msg-1", ...input, sourceId: null }),
        )
        .mockImplementationOnce((input) =>
          Promise.resolve({ id: "msg-2", ...input, sourceId: null }),
        )

      await send("first")
      await send("second")

      const opts = challengeCalls().map(([, , options]) => options)
      expect(opts).toEqual([
        { jobId: "step-challenge-conv-1-msg-1" },
        { jobId: "step-challenge-conv-1-msg-2" },
      ])
      for (const o of opts) {
        expect(o).not.toHaveProperty("deduplication")
      }
    })
  })

  test("enqueues webchat postbacks through flow action debounce", async () => {
    await handleCreateWebchatMessage({
      parsedInput: {
        text: "clicked",
        postback: "button-a",
        workspaceId: "1",
        webchatId: "webchat-1",
        guestConversationId: "1:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
        guestSecret: GUEST_SECRET,
      },
    })

    expect(mockAutomatedResponseEnqueueFlowAction).toHaveBeenCalledWith({
      kind: "postback",
      data: {
        conversationId: conversation,
        contactInboxId: contactInbox,
        action: "button-a",
      },
    })
    expect(mockAutomatedResponseEnqueue).not.toHaveBeenCalled()
  })

  test("rejects unauthorized webchat origins before resolving conversations", async () => {
    mockFindOrFail.mockResolvedValue({
      inboxId: "inbox-1",
      authorizedDomains: ["example.com"],
    })

    await expect(
      handleCreateWebchatMessage({
        parsedInput: {
          text: "hello",
          workspaceId: "1",
          webchatId: "webchat-1",
          guestConversationId: "1:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
          guestSecret: GUEST_SECRET,
          parentOrigin: "https://attacker.test",
        },
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      httpStatusCode: 403,
    })

    expect(mockContactInboxFindLatest).not.toHaveBeenCalled()
  })

  test("accepts the hub's own origin (the builder preview) under an allowlist (s210)", async () => {
    appHost.current = "app.chatbotx.io"
    mockFindOrFail.mockResolvedValue({
      inboxId: "inbox-1",
      authorizedDomains: ["example.com"],
    })

    await handleCreateWebchatMessage({
      parsedInput: {
        text: "hello",
        workspaceId: "1",
        webchatId: "webchat-1",
        guestConversationId: "1:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
        guestSecret: GUEST_SECRET,
        parentOrigin: "app.chatbotx.io",
      },
    }).catch((error: { httpStatusCode?: number }) => {
      expect(error?.httpStatusCode).not.toBe(403)
    })

    expect(mockContactInboxFindLatest).toHaveBeenCalled()
  })

  test("never treats the hub origin as first party when the proxy host is missing", async () => {
    appHost.current = ""
    mockFindOrFail.mockResolvedValue({
      inboxId: "inbox-1",
      authorizedDomains: ["example.com"],
    })

    await expect(
      handleCreateWebchatMessage({
        parsedInput: {
          text: "hello",
          workspaceId: "1",
          webchatId: "webchat-1",
          guestConversationId: "1:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
          guestSecret: GUEST_SECRET,
          parentOrigin: "app.chatbotx.io",
        },
      }),
    ).rejects.toMatchObject({ code: "forbidden", httpStatusCode: 403 })
    appHost.current = "app.chatbotx.io"
  })

  test("rejects an invalid access token even when no authorizedDomains are configured", async () => {
    // Bind-on-first-use: the token must always verify, regardless of
    // whether the webchat has an authorizedDomains allowlist configured.
    mockVerifyWebchatAccessToken.mockResolvedValue({
      authorized: false,
    })

    await expect(
      handleCreateWebchatMessage({
        parsedInput: {
          text: "hello",
          workspaceId: "1",
          webchatId: "webchat-1",
          guestConversationId: "1:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
          guestSecret: GUEST_SECRET,
        },
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      httpStatusCode: 403,
    })

    expect(mockContactInboxFindLatest).not.toHaveBeenCalled()
  })
})

describe("handleCreateWebchatMessage — flowId", () => {
  beforeEach(() => {
    resetCommonMocks()
    mockContactInboxFindLatest.mockResolvedValue(contactInbox)
  })

  test("rejects a flowId that is not configured as a persistent menu flow (flow injection / IDOR)", async () => {
    mockFindOrFail.mockResolvedValue({
      inboxId: "inbox-1",
      authorizedDomains: [],
      persistentMenus: [
        { label: "Talk to sales", type: "flow", flowId: "flow-allowed" },
      ],
    })

    await expect(
      handleCreateWebchatMessage({
        parsedInput: {
          flowId: "flow-attacker",
          workspaceId: "1",
          webchatId: "webchat-1",
          guestConversationId: "1:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
          guestSecret: GUEST_SECRET,
        },
      }),
    ).rejects.toMatchObject({
      code: "notFound",
      httpStatusCode: 404,
    })

    expect(mockIntegrationQueueAdd).not.toHaveBeenCalled()
  })

  test("enqueues a flowId that matches a configured persistent menu flow", async () => {
    mockFindOrFail.mockResolvedValue({
      inboxId: "inbox-1",
      authorizedDomains: [],
      persistentMenus: [
        { label: "Talk to sales", type: "flow", flowId: "flow-allowed" },
      ],
    })

    await handleCreateWebchatMessage({
      parsedInput: {
        flowId: "flow-allowed",
        workspaceId: "1",
        webchatId: "webchat-1",
        guestConversationId: "1:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
        guestSecret: GUEST_SECRET,
      },
    })

    expect(mockIntegrationQueueAdd).toHaveBeenCalledWith(
      "sendFlow",
      expect.objectContaining({
        type: "sendFlow",
        data: expect.objectContaining({
          conversationId: expect.objectContaining({ id: "conv-1" }),
          contactInboxId: expect.objectContaining({ id: "ci-1" }),
          flowId: "flow-allowed",
          origin: "channel",
        }),
      }),
    )
  })
})

describe("handleCreateWebchatMessage — MAC quota", () => {
  beforeEach(() => {
    resetCommonMocks()
  })

  const input = {
    text: "hello",
    workspaceId: "1",
    webchatId: "webchat-1",
    guestConversationId: "1:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
    guestSecret: GUEST_SECRET,
  }

  const seedNewContactInserts = () => {
    insertBuilder.returning
      .mockResolvedValueOnce([
        {
          id: "contact-new",
          workspaceId: "1",
          createdAt: new Date("2026-06-21T00:00:00Z"),
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "ci-new",
          inboxId: "inbox-1",
          contactId: "contact-new",
          sourceId: "guest-1",
          source: "webchat",
          channel: "webchat",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "conv-new",
          workspaceId: "1",
          contactId: "contact-new",
          additionalAttributes: null,
        },
      ])
  }

  test("does not touch quota for an existing contact", async () => {
    mockContactInboxFindLatest.mockResolvedValue(contactInbox)

    await handleCreateWebchatMessage({ parsedInput: input })

    expect(mockCreateNewContactWithMac).not.toHaveBeenCalled()
    expect(mockQuotaIncrement).not.toHaveBeenCalled()
  })

  test("a returning visitor never spends the guest-creation budget (s217)", async () => {
    mockContactInboxFindLatest.mockResolvedValue(contactInbox)

    await handleCreateWebchatMessage({ parsedInput: input })

    expect(mockCheckGuestCreateRateLimit).not.toHaveBeenCalled()
  })

  test("a new guest is checked against the per-ip creation budget (s217)", async () => {
    mockContactInboxFindLatest.mockResolvedValue(undefined)
    seedNewContactInserts()

    await handleCreateWebchatMessage({ parsedInput: input })

    expect(mockCheckGuestCreateRateLimit).toHaveBeenCalledWith({
      clientIp: "192.0.2.1",
    })
  })

  test("an exhausted creation budget answers 429 and creates nothing (s217)", async () => {
    mockContactInboxFindLatest.mockResolvedValue(undefined)
    mockCheckGuestCreateRateLimit.mockResolvedValue({
      limited: true,
      retryAfter: 42,
    })

    await expect(
      handleCreateWebchatMessage({ parsedInput: input }),
    ).rejects.toMatchObject({
      code: "rateLimitExceeded",
      httpStatusCode: 429,
    })

    expect(mockCreateNewContactWithMac).not.toHaveBeenCalled()
    expect(tx.insert).not.toHaveBeenCalled()
    expect(mockEmitContactCreated).not.toHaveBeenCalled()
  })

  test("does not requeue the welcome flow for a returning visitor", async () => {
    mockContactInboxFindLatest.mockResolvedValue(contactInbox)
    mockFindOrFail.mockResolvedValue({
      inboxId: "inbox-1",
      authorizedDomains: [],
      welcomeFlowId: "flow-1",
    })

    await handleCreateWebchatMessage({ parsedInput: input })

    expect(mockEmitContactCreated).not.toHaveBeenCalled()
    expect(mockIntegrationQueueAdd).not.toHaveBeenCalled()
  })

  test("gates a new contact through the atomic MAC chokepoint", async () => {
    mockContactInboxFindLatest.mockResolvedValue(undefined)
    seedNewContactInserts()

    await handleCreateWebchatMessage({ parsedInput: input })

    expect(mockWorkspaceFind).toHaveBeenCalledWith({ where: { id: "1" } })
    // MAC is gated + consumed atomically with the insert (owner-derived). The
    // info-only `contacts` counter is recorded inside this chokepoint too, so
    // the action no longer increments it separately (that would double-count).
    expect(mockCreateNewContactWithMac).toHaveBeenCalledTimes(1)
    expect(mockCreateNewContactWithMac).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "owner-1", workspaceId: "1" }),
    )
    expect(insertBuilder.values).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "webchat",
        source: "webchat",
      }),
    )
    expect(mockQuotaIncrement).not.toHaveBeenCalled()
  })

  test("emits contact creation and queues the configured welcome flow for a new contact", async () => {
    mockContactInboxFindLatest.mockResolvedValue(undefined)
    mockFindOrFail.mockResolvedValue({
      inboxId: "inbox-1",
      authorizedDomains: [],
      welcomeFlowId: "flow-1",
    })
    seedNewContactInserts()

    await handleCreateWebchatMessage({
      parsedInput: {
        ...input,
        init: true,
      },
    })

    expect(mockEmitContactCreated).toHaveBeenCalledWith(
      "1",
      "contact-new",
      undefined,
      undefined,
      undefined,
      "ci-new",
    )
    expect(mockIntegrationQueueAdd).toHaveBeenCalledWith(
      "sendFlow",
      expect.objectContaining({
        type: "sendFlow",
        data: expect.objectContaining({
          conversationId: expect.objectContaining({ id: "conv-new" }),
          contactInboxId: expect.objectContaining({ id: "ci-new" }),
          flowId: "flow-1",
          origin: "channel",
        }),
      }),
    )
  })

  test("does not queue a welcome flow when it is not configured", async () => {
    mockContactInboxFindLatest.mockResolvedValue(undefined)
    seedNewContactInserts()

    await handleCreateWebchatMessage({
      parsedInput: {
        ...input,
        init: true,
      },
    })

    expect(mockEmitContactCreated).toHaveBeenCalledTimes(1)
    expect(mockIntegrationQueueAdd).not.toHaveBeenCalledWith(
      "sendFlow",
      expect.anything(),
    )
  })

  test("rejects and creates nothing when the MAC limit is reached", async () => {
    mockContactInboxFindLatest.mockResolvedValue(undefined)
    mockCreateNewContactWithMac.mockResolvedValue({
      ok: false,
      level: "user",
    })

    await expect(
      handleCreateWebchatMessage({ parsedInput: input }),
    ).rejects.toMatchObject({
      message: "Contact limit reached",
      code: "quotaExceeded",
    })

    expect(tx.insert).not.toHaveBeenCalled()
    expect(mockQuotaIncrement).not.toHaveBeenCalled()
  })

  test("stores locale and timezone on new webchat contacts", async () => {
    mockContactInboxFindLatest.mockResolvedValue(undefined)
    seedNewContactInserts()

    await handleCreateWebchatMessage({
      parsedInput: {
        ...input,
        locale: "vi-VN",
        timezone: "Asia/Ho_Chi_Minh",
      },
    })

    expect(insertBuilder.values).toHaveBeenCalledWith(
      expect.objectContaining({
        firstName: "Guest",
        locale: "vi_VN",
        timezone: "Asia/Ho_Chi_Minh",
      }),
    )
    expect(insertBuilder.values).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "webchat",
        language: "vi",
      }),
    )
  })

  test("creates new webchat contacts when locale and timezone are absent", async () => {
    mockContactInboxFindLatest.mockResolvedValue(undefined)
    seedNewContactInserts()

    await handleCreateWebchatMessage({ parsedInput: input })

    expect(insertBuilder.values).toHaveBeenCalledWith(
      expect.objectContaining({
        firstName: "Guest",
        locale: undefined,
        timezone: undefined,
      }),
    )
    expect(insertBuilder.values).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "webchat",
        language: undefined,
      }),
    )
  })

  test.each([
    ["a legacy digits-only id", "11616773281153025"],
    ["another workspace's minted id", "9:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f"],
  ])("the raw handler refuses %s before any lookup (s213)", async (_, id) => {
    await expect(
      handleCreateWebchatMessage({
        parsedInput: { ...input, guestConversationId: id },
      }),
    ).rejects.toThrow()
    expect(mockWorkspaceFind).not.toHaveBeenCalled()
    expect(mockContactInboxFindLatest).not.toHaveBeenCalled()
    expect(tx.insert).not.toHaveBeenCalled()
  })

  test.each([
    ["no secret (the id alone, as the API and exports show it)", undefined],
    ["an empty secret", ""],
    ["a well-formed guess", "0".repeat(64)],
    ["the secret upper-cased", "UPPER"],
  ])("the raw handler refuses %s with 401 before any lookup or create (s215)", async (_, secret) => {
    mockContactInboxFindLatest.mockResolvedValue(undefined)
    const guestSecret = secret === "UPPER" ? GUEST_SECRET.toUpperCase() : secret
    await expect(
      handleCreateWebchatMessage({
        parsedInput: { ...input, guestSecret },
      }),
    ).rejects.toMatchObject({
      code: "guestSecretRefused",
      httpStatusCode: 401,
    })
    expect(mockWorkspaceFind).not.toHaveBeenCalled()
    expect(mockVerifyWebchatAccessToken).not.toHaveBeenCalled()
    expect(mockCheckGuestRateLimit).not.toHaveBeenCalled()
    expect(mockContactInboxFindLatest).not.toHaveBeenCalled()
    expect(tx.insert).not.toHaveBeenCalled()
  })

  test("another guest's secret does not open this id (s215)", async () => {
    const other = await signGuestSecret(
      "1:1f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
      process.env.REALTIME_BROADCAST_SECRET as string,
    )
    await expect(
      handleCreateWebchatMessage({
        parsedInput: { ...input, guestSecret: other },
      }),
    ).rejects.toMatchObject({ httpStatusCode: 401 })
    expect(mockContactInboxFindLatest).not.toHaveBeenCalled()
  })

  test("never copies the guest id into the new contact's email (s213)", async () => {
    mockContactInboxFindLatest.mockResolvedValue(undefined)
    seedNewContactInserts()

    await handleCreateWebchatMessage({ parsedInput: input })

    expect(insertBuilder.values).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: "Guest", email: null }),
    )
    for (const [values] of insertBuilder.values.mock.calls) {
      expect(JSON.stringify(values ?? {})).not.toContain(
        `"email":"${input.guestConversationId}"`,
      )
    }
  })

  test("does not create a contact for existing webchat inbox even with payload locale and timezone", async () => {
    mockContactInboxFindLatest.mockResolvedValue(contactInbox)

    await handleCreateWebchatMessage({
      parsedInput: {
        ...input,
        locale: "vi-VN",
        timezone: "Asia/Ho_Chi_Minh",
      },
    })

    expect(tx.insert).not.toHaveBeenCalled()
  })
})
