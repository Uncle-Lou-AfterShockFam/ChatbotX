import { beforeEach, describe, expect, test, vi } from "vitest"

const { mockPostSignedEnvelope } = vi.hoisted(() => ({
  mockPostSignedEnvelope: vi.fn(),
}))

vi.mock("../src/lib/delivery", () => ({
  postSignedEnvelope: mockPostSignedEnvelope,
}))

const { mockEnqueue, mockMint } = vi.hoisted(() => ({
  mockEnqueue: vi.fn(),
  mockMint: vi.fn(),
}))
vi.mock("@chatbotx.io/business", async () => ({
  // The pure rewrite + URL helpers are the real ones; only the DB-backed
  // service is mocked.
  ...(await vi.importActual<Record<string, unknown>>(
    "../../../packages/business/src/tracked-link/rewrite",
  )),
  ...(await vi.importActual<Record<string, unknown>>(
    "../../../packages/business/src/tracked-link/url",
  )),
  apiChannelOutboxService: { enqueue: mockEnqueue },
  trackedLinkService: { mint: mockMint },
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
    ).rejects.toThrow("no inbox")
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
    ).rejects.toThrow("no channel identity")
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

const MISSING_CONTACT_ID = /short links: the contact id is missing/

describe("api short links (fork, s170)", () => {
  const APP = "https://hub.example"
  const LONG = `${APP}/booking/picker?token=${"t".repeat(1200)}`
  const SHORT = "https://x.y/a"
  const shortCtx = {
    auth: { callbackUrl: "https://example.com/callback", signingSecret: "s" },
    integrationDetail: { inboxId: "inbox-9", workspaceId: "ws-1" },
    platform: { appUrl: APP },
  } as never
  const inboxContact = {
    id: "ci-1",
    contactId: "contact-1",
    sourceId: "+15550000008",
  } as never

  beforeEach(() => {
    vi.clearAllMocks()
    mockPostSignedEnvelope.mockResolvedValue({ messageId: "m_1" })
    mockEnqueue.mockResolvedValue("ob_1")
    let n = 0
    mockMint.mockImplementation(() => Promise.resolve(`tok${++n}`))
  })

  test("sendMessage: a long URL in the text and a URL quick reply become /go/ links, a short URL stays, attribution names the contact", async () => {
    await sendMessage({
      ctx: shortCtx,
      data: {
        contact: inboxContact,
        message: {
          id: "msg-1",
          conversationId: "conv-1",
          text: `Choose a time ${LONG} or ${SHORT}`,
          messageType: "outgoing",
          contentType: "text",
        },
        quickReplies: [
          { id: "b1", label: "Select Date", buttonType: "url", url: LONG },
          { id: "b2", label: "Site", buttonType: "url", url: SHORT },
          { id: "b3", label: "Later", buttonType: "postback", postback: "x" },
        ],
      },
    } as never)

    const [{ envelope }] = mockPostSignedEnvelope.mock.calls[0]
    expect(envelope.message.text).toBe(
      `Choose a time ${APP}/go/tok1 or ${SHORT}`,
    )
    expect(envelope.message.quickReplies).toEqual([
      {
        id: "b1",
        label: "Select Date",
        buttonType: "url",
        url: `${APP}/go/tok2`,
      },
      { id: "b2", label: "Site", buttonType: "url", url: SHORT },
      { id: "b3", label: "Later", buttonType: "postback", postback: "x" },
    ])
    expect(mockMint).toHaveBeenCalledTimes(2)
    expect(mockMint.mock.calls[0][0]).toEqual({
      workspaceId: "ws-1",
      contactId: "contact-1",
      contactInboxId: "ci-1",
      flowId: null,
      stepId: null,
      url: LONG,
    })
  })

  test("sendFlowStep: the flow and step ids ride the attribution and the pull outbox carries the short form", async () => {
    await sendFlowStep({
      ctx: {
        ...shortCtx,
        auth: { ...shortCtx.auth, deliveryMode: "pull" },
      } as never,
      data: {
        contact: inboxContact,
        flowId: "flow-7",
        quickReplies: [],
        step: {
          id: "step-3",
          nodeId: "node-3",
          stepType: "bulktextSend",
          text: `Book here: ${LONG}`,
          photoUrl: "",
          dryRun: false,
          platform: "gv",
        },
      },
    } as never)

    expect(mockPostSignedEnvelope).not.toHaveBeenCalled()
    const [args] = mockEnqueue.mock.calls[0]
    expect(args.envelope.message.text).toBe(`Book here: ${APP}/go/tok1`)
    expect(mockMint.mock.calls[0][0]).toMatchObject({
      flowId: "flow-7",
      stepId: "step-3",
      contactId: "contact-1",
    })
  })

  test("a /go/ link already minted by the chat worker is not wrapped again, and the open pixel is untouched", async () => {
    const pixel = `${APP}/go/pix00000001/o`
    await sendFlowStep({
      ctx: shortCtx,
      data: {
        contact: inboxContact,
        flowId: "flow-7",
        quickReplies: [],
        step: {
          id: "step-3",
          nodeId: "node-3",
          stepType: "bulktextSend",
          text: `Tracked ${APP}/go/tok00000001 already`,
          photoUrl: "",
          dryRun: false,
          platform: "gv",
          openPixel: pixel,
        },
      },
    } as never)

    expect(mockMint).not.toHaveBeenCalled()
    const [{ envelope }] = mockPostSignedEnvelope.mock.calls[0]
    expect(envelope.message.text).toBe(`Tracked ${APP}/go/tok00000001 already`)
    expect(envelope.message.contentAttributes.bulktext.openPixel).toBe(pixel)
  })

  test("shortenLinks: false leaves the long URL alone and mints nothing", async () => {
    await sendMessage({
      ctx: {
        ...shortCtx,
        auth: { ...shortCtx.auth, shortenLinks: false },
      } as never,
      data: {
        contact: inboxContact,
        message: {
          id: "m",
          conversationId: "c",
          text: LONG,
          messageType: "outgoing",
          contentType: "text",
        },
        quickReplies: [],
      },
    } as never)
    expect(mockMint).not.toHaveBeenCalled()
    const [{ envelope }] = mockPostSignedEnvelope.mock.calls[0]
    expect(envelope.message.text).toBe(LONG)
  })

  test("nothing to shorten never touches the ids: a bare context with a short text still posts", async () => {
    await sendMessage({
      ctx: { auth: shortCtx.auth } as never,
      data: {
        contact: { id: "ci-1", sourceId: "+15550000008" } as never,
        message: {
          id: "m",
          conversationId: "c",
          text: `hi ${SHORT}`,
          messageType: "outgoing",
          contentType: "text",
        },
        quickReplies: [],
      },
    } as never)
    expect(mockMint).not.toHaveBeenCalled()
    expect(mockPostSignedEnvelope).toHaveBeenCalledTimes(1)
  })

  test("a candidate with no contact id, or a failing mint, fails the send (nothing posted, nothing queued)", async () => {
    await expect(
      sendMessage({
        ctx: shortCtx,
        data: {
          contact: { id: "ci-1", sourceId: "+15550000008" } as never,
          message: {
            id: "m",
            conversationId: "c",
            text: LONG,
            messageType: "outgoing",
            contentType: "text",
          },
          quickReplies: [],
        },
      } as never),
    ).rejects.toThrow(MISSING_CONTACT_ID)

    mockMint.mockRejectedValue(new Error("db down"))
    await expect(
      sendMessage({
        ctx: shortCtx,
        data: {
          contact: inboxContact,
          message: {
            id: "m",
            conversationId: "c",
            text: LONG,
            messageType: "outgoing",
            contentType: "text",
          },
          quickReplies: [],
        },
      } as never),
    ).rejects.toThrow("db down")
    expect(mockPostSignedEnvelope).not.toHaveBeenCalled()
    expect(mockEnqueue).not.toHaveBeenCalled()
  })
})
