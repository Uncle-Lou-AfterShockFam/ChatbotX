import { beforeEach, describe, expect, test, vi } from "vitest"

const { mockPostSignedEnvelope } = vi.hoisted(() => ({
  mockPostSignedEnvelope: vi.fn(),
}))

vi.mock("../src/lib/delivery", () => ({
  postSignedEnvelope: mockPostSignedEnvelope,
}))

const { mockEnqueue } = vi.hoisted(() => ({ mockEnqueue: vi.fn() }))
vi.mock("@chatbotx.io/business", () => ({
  apiChannelOutboxService: { enqueue: mockEnqueue },
}))

const { sendFlowStep, sendMessage } = await import(
  "../src/handlers/message/outgoing-message"
)

const ctx = {
  auth: {
    callbackUrl: "https://example.com/callback",
    signingSecret: "secret",
  },
} as never

const contact = { id: "contact-1", sourceId: "source-1" } as never

describe("api sendFlowStep — sendMultipleImages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPostSignedEnvelope.mockResolvedValue({ messageId: "m_1" })
  })

  test("maps every image into contentAttributes.attachments instead of degrading to text", async () => {
    const result = await sendFlowStep({
      ctx,
      data: {
        contact,
        quickReplies: [],
        step: {
          id: "step-1",
          nodeId: "node-1",
          stepType: "sendMultipleImages",
          images: [
            { id: "img-1", mode: "url", url: "https://example.com/a.png" },
            { id: "img-2", mode: "url", url: "https://example.com/b.png" },
            { id: "img-3", mode: "url", url: "https://example.com/c.png" },
          ],
        },
      },
    } as never)

    expect(mockPostSignedEnvelope).toHaveBeenCalledTimes(1)
    const [{ envelope }] = mockPostSignedEnvelope.mock.calls[0]
    expect(envelope.message.text).toBeNull()
    expect(envelope.message.contentAttributes).toEqual({
      attachments: [
        { url: "https://example.com/a.png", fileType: "image" },
        { url: "https://example.com/b.png", fileType: "image" },
        { url: "https://example.com/c.png", fileType: "image" },
      ],
    })
    expect(result).toEqual({ messageIds: ["m_1"] })
  })
})

describe("api sendFlowStep — bulktextSend", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPostSignedEnvelope.mockResolvedValue({ messageId: "msg:57" })
  })

  test("carries the text, a photo attachment and the delivery options under contentAttributes.bulktext", async () => {
    const result = await sendFlowStep({
      ctx,
      data: {
        contact,
        quickReplies: [],
        step: {
          id: "step-1",
          nodeId: "node-1",
          stepType: "bulktextSend",
          text: "Hi Lou",
          photoUrl: "https://example.com/a.jpg",
          ref: "camp:1",
          dryRun: false,
          scheduleAt: "",
          spreadOverMinutes: 30,
          skipIfRepliedSince: "2026-09-20T00:00:00Z",
        },
      },
    } as never)

    const [{ envelope }] = mockPostSignedEnvelope.mock.calls[0]
    expect(envelope.message.text).toBe("Hi Lou")
    expect(envelope.message.contentAttributes).toEqual({
      attachments: [{ url: "https://example.com/a.jpg", fileType: "image" }],
      bulktext: {
        dryRun: false,
        ref: "camp:1",
        spreadOverMinutes: 30,
        skipIfRepliedSince: "2026-09-20T00:00:00Z",
      },
    })
    expect(result).toEqual({ messageIds: ["msg:57"] })
  })

  test("photo-only: null text, no empty option keys", async () => {
    await sendFlowStep({
      ctx,
      data: {
        contact,
        quickReplies: [],
        step: {
          id: "step-1",
          nodeId: "node-1",
          stepType: "bulktextSend",
          text: "",
          photoUrl: "https://example.com/a.jpg",
          ref: "",
          dryRun: true,
          scheduleAt: "",
          spreadOverMinutes: 0,
          skipIfRepliedSince: "",
        },
      },
    } as never)
    const [{ envelope }] = mockPostSignedEnvelope.mock.calls[0]
    expect(envelope.message.text).toBeNull()
    expect(envelope.message.contentAttributes).toEqual({
      attachments: [{ url: "https://example.com/a.jpg", fileType: "image" }],
      bulktext: { dryRun: true },
    })
  })
})

describe("api sendFlowStep — a bulktext refusal is a failed send, not a silent success", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const step = {
    id: "step-1",
    nodeId: "node-1",
    stepType: "sendText",
    text: "hi",
    buttons: [],
  }

  test("a 200 with a non-null reason and no message id throws with the reason and warning", async () => {
    mockPostSignedEnvelope.mockResolvedValue({
      ok: true,
      reason: "bad-options",
      warning: "skipIfRepliedSince must not be in the future",
      messageId: null,
      batchId: null,
    })
    await expect(
      sendFlowStep({ ctx, data: { contact, quickReplies: [], step } } as never),
    ).rejects.toThrow(
      "bulktext refused the send (bad-options): skipIfRepliedSince must not be in the future",
    )
  })

  test("suppressed WITH a hook message id is not a refusal here: the async failed status carries the verdict", async () => {
    mockPostSignedEnvelope.mockResolvedValue({
      ok: true,
      reason: "suppressed",
      messageId: "hook:12",
      warning: null,
    })
    await expect(
      sendFlowStep({ ctx, data: { contact, quickReplies: [], step } } as never),
    ).resolves.toEqual({ messageIds: ["hook:12"] })
  })

  test("a duplicate refusal (message id of the earlier send, reason set) still throws", async () => {
    mockPostSignedEnvelope.mockResolvedValue({
      ok: true,
      reason: "duplicate",
      messageId: "msg:5",
      warning: null,
    })
    await expect(
      sendFlowStep({ ctx, data: { contact, quickReplies: [], step } } as never),
    ).rejects.toThrow("bulktext refused the send (duplicate)")
  })

  test("no reason key at all (an inbound-only or non-bulktext API channel) is untouched", async () => {
    mockPostSignedEnvelope.mockResolvedValue({ messageId: "m_1" })
    await expect(
      sendFlowStep({ ctx, data: { contact, quickReplies: [], step } } as never),
    ).resolves.toEqual({ messageIds: ["m_1"] })
    mockPostSignedEnvelope.mockResolvedValue(null)
    await expect(
      sendFlowStep({ ctx, data: { contact, quickReplies: [], step } } as never),
    ).resolves.toEqual({ messageIds: [] })
  })
})

describe("api pull delivery mode (fork, s164)", () => {
  const pullCtx = {
    auth: { callbackUrl: null, signingSecret: "secret", deliveryMode: "pull" },
    integrationDetail: { inboxId: "inbox-9", workspaceId: "ws-1" },
  } as never

  beforeEach(() => {
    vi.clearAllMocks()
    mockEnqueue.mockResolvedValue("ob_1")
  })

  test("sendMessage queues the envelope instead of posting and answers outbox:<id>", async () => {
    const result = await sendMessage({
      ctx: pullCtx,
      data: {
        contact,
        quickReplies: [],
        message: {
          id: "m-1",
          conversationId: "c-1",
          text: "Hi",
          messageType: "outgoing",
          contentType: "text",
          attachments: [],
          contentAttributes: {},
        },
      },
    } as never)
    expect(mockPostSignedEnvelope).not.toHaveBeenCalled()
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    const [args] = mockEnqueue.mock.calls[0]
    expect(args.inboxId).toBe("inbox-9")
    expect(args.workspaceId).toBe("ws-1")
    expect(args.contactSourceId).toBe("source-1")
    expect(args.envelope.event).toBe("message_created")
    expect(args.envelope.message.id).toBe("m-1")
    expect(args.envelope.contact).toEqual({
      id: "contact-1",
      sourceId: "source-1",
    })
    expect(result).toEqual({ messageIds: ["outbox:ob_1"] })
  })

  test("sendFlowStep queues the same envelope a callback would carry, bulktext options included", async () => {
    const result = await sendFlowStep({
      ctx: pullCtx,
      data: {
        contact,
        quickReplies: [],
        step: {
          id: "step-1",
          nodeId: "node-1",
          stepType: "bulktextSend",
          text: "Hi Lou",
          photoUrl: "",
          ref: "native:1",
          dryRun: true,
          scheduleAt: "",
          spreadOverMinutes: 2,
          skipIfRepliedSince: "",
        },
      },
    } as never)
    expect(mockPostSignedEnvelope).not.toHaveBeenCalled()
    const [args] = mockEnqueue.mock.calls[0]
    expect(args.envelope.message.text).toBe("Hi Lou")
    expect(args.envelope.message.contentAttributes.bulktext).toEqual({
      dryRun: true,
      ref: "native:1",
      spreadOverMinutes: 2,
    })
    expect(result).toEqual({ messageIds: ["outbox:ob_1"] })
  })

  test("a pull inbox whose row carries no inbox id, or a contact with no identity, throws (nothing queued)", async () => {
    await expect(
      sendMessage({
        ctx: { ...pullCtx, integrationDetail: {} } as never,
        data: {
          contact,
          quickReplies: [],
          message: {
            id: "m",
            text: "x",
            messageType: "outgoing",
            contentType: "text",
            attachments: [],
            contentAttributes: {},
          },
        },
      } as never),
    ).rejects.toThrow(/no inbox/)
    await expect(
      sendMessage({
        ctx: pullCtx,
        data: {
          contact: { id: "c", sourceId: "" },
          quickReplies: [],
          message: {
            id: "m",
            text: "x",
            messageType: "outgoing",
            contentType: "text",
            attachments: [],
            contentAttributes: {},
          },
        },
      } as never),
    ).rejects.toThrow(/no channel identity/)
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  test("push mode without a callback URL stays inbound-only (unchanged), and push mode with one still posts", async () => {
    mockPostSignedEnvelope.mockResolvedValue({ messageId: "msg:1" })
    const quiet = await sendFlowStep({
      ctx: {
        auth: { callbackUrl: null, signingSecret: "s" },
        integrationDetail: {},
      } as never,
      data: {
        contact,
        quickReplies: [],
        step: {
          id: "s",
          nodeId: "n",
          stepType: "sendText",
          text: "x",
          buttons: [],
        },
      },
    } as never)
    expect(quiet).toEqual({ messageIds: [] })
    expect(mockEnqueue).not.toHaveBeenCalled()
    const posted = await sendFlowStep({
      ctx,
      data: {
        contact,
        quickReplies: [],
        step: {
          id: "s",
          nodeId: "n",
          stepType: "sendText",
          text: "x",
          buttons: [],
        },
      },
    } as never)
    expect(posted).toEqual({ messageIds: ["msg:1"] })
    expect(mockPostSignedEnvelope).toHaveBeenCalledTimes(1)
  })
})
