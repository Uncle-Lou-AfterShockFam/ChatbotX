import { beforeEach, describe, expect, test, vi } from "vitest"
import type { ExecuteStepProps } from "../src/integration/handlers/flow-utils"

const mocks = vi.hoisted(() => ({
  updateChallenge: vi.fn(async () => undefined),
  consumeChallenge: vi.fn(async () => true),
  start: vi.fn(),
  answer: vi.fn(),
  markAsked: vi.fn(async () => true),
  markUndelivered: vi.fn(async () => true),
  claimExpiredRoute: vi.fn(async () => true),
  delivered: vi.fn(async () => true),
  findById: vi.fn(),
  chatQueueAdd: vi.fn(async () => ({ id: "job" })),
  waitForChatJobCompletion: vi.fn(async () => undefined),
  findMessageById: vi.fn(),
  findLastByConversation: vi.fn(async () => []),
  signToken: vi.fn(async () => "signed-token"),
}))

vi.mock("@chatbotx.io/business", () => ({
  conversationService: {
    updateChallenge: mocks.updateChallenge,
    consumeChallenge: mocks.consumeChallenge,
  },
  normalizeLanguage: (l: string | null | undefined) => l ?? "en",
  resolveTenantSettings: vi.fn(async () => ({
    appUrl: "https://chat.example.org",
    storageUrl: "https://files.example.org",
  })),
  workspaceService: { findById: vi.fn(async () => ({ language: "en" })) },
  questionnaireSubmissionService: {},
}))
vi.mock("@chatbotx.io/business/form", () => ({
  formSessionService: {
    start: mocks.start,
    answer: mocks.answer,
    markAsked: mocks.markAsked,
    markUndelivered: mocks.markUndelivered,
    claimExpiredRoute: mocks.claimExpiredRoute,
    findById: mocks.findById,
  },
}))
vi.mock("@chatbotx.io/business/utils", () => ({
  getPublicFileUrl: (key: string, base: string) => `${base}/${key}`,
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  createMessageRepository: vi.fn(async () => ({
    findById: mocks.findMessageById,
    findLastByConversation: mocks.findLastByConversation,
  })),
  getSafeSinceTime: vi.fn(() => new Date("2025-01-01T00:00:00Z")),
}))
vi.mock("@chatbotx.io/encryption", () => ({
  signUserDataWebviewToken: mocks.signToken,
}))
vi.mock("@chatbotx.io/events/context", () => ({
  webhookChannelOrigin: () => "channel",
}))
vi.mock("@chatbotx.io/worker-config", () => ({
  ChatJobAction: { sendChatMessage: "sendChatMessage" },
  IntegrationJobAction: { sendFlow: "sendFlow" },
  chatQueue: { add: mocks.chatQueueAdd },
  integrationQueue: { add: vi.fn() },
}))
vi.mock("../src/integration/utils/message", () => ({
  waitForChatJobCompletion: mocks.waitForChatJobCompletion,
  waitForChatJobDelivered: mocks.delivered,
}))
vi.mock("../src/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { askForm } = await import("../src/integration/handlers/ask-form")

const step = {
  id: "step-1",
  stepType: "askForm",
  formId: "11700000000000001",
  timeoutMinutes: 60,
  maxAttempts: 3,
  retryMessage: "",
  states: [
    { id: "ok", stateType: "success" },
    { id: "no", stateType: "skip" },
  ],
}

const session = (over: Record<string, unknown> = {}) => ({
  id: "session-1",
  workspaceId: "ws-1",
  nodeId: "node-1",
  stepId: "step-1",
  conversationId: "conv-1",
  challengeId: "ch-1",
  attempts: 0,
  status: "inProgress",
  ...over,
})

const colorField = {
  key: "color",
  type: "select",
  label: "Favourite color?",
  required: true,
  options: [
    { value: "red", label: "Red" },
    { value: "blue", label: "Blue" },
  ],
}

function props(
  over: Partial<ExecuteStepProps<never>> & { channel?: string } = {},
): ExecuteStepProps<never> {
  const { channel = "api", ...rest } = over
  return {
    conversation: {
      id: "conv-1",
      workspaceId: "ws-1",
      contactId: "contact-1",
      additionalAttributes: {},
      lastActivityAt: new Date(),
      createdAt: new Date(),
    },
    contactInbox: { id: "ci-1", contactId: "contact-1", channel },
    flowVersion: { id: "fv-1", flowId: "flow-1" },
    targetId: "node-1",
    step,
    ...rest,
  } as unknown as ExecuteStepProps<never>
}

const resumed = {
  variables: { conversation: { challengeAttempts: { value: 1 } } },
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("askForm handler", () => {
  test("first entry starts the run, writes the challenge, asks, THEN confirms delivery", async () => {
    mocks.start.mockResolvedValue({
      kind: "ask",
      session: session(),
      field: colorField,
      preface: [{ key: "hi", type: "paragraph", label: "Welcome!" }],
      retry: false,
    })
    const out = await askForm(props())
    expect(out).toEqual({ status: "wait", result: null })
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        formId: step.formId,
        contactInboxId: "ci-1",
        nodeId: "node-1",
        stepId: "step-1",
        timeoutMinutes: 60,
        maxAttempts: 3,
      }),
    )
    const texts = mocks.chatQueueAdd.mock.calls.map(
      (c) => (c[1] as { data: { text: string } }).data.text,
    )
    // The preface first, then the numbered question (api has no buttons).
    expect(texts).toEqual(["Welcome!", "Favourite color?\n1. Red\n2. Blue"])
    expect(mocks.updateChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        challenge: expect.objectContaining({
          data: expect.objectContaining({
            stepId: "step-1",
            challengeId: "ch-1",
          }),
        }),
      }),
    )
    const sendOrder = mocks.delivered.mock.invocationCallOrder.at(-1) ?? 0
    expect(mocks.markAsked.mock.invocationCallOrder[0]).toBeGreaterThan(
      sendOrder,
    )
    expect(mocks.markAsked).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sessionId: "session-1",
      challengeId: "ch-1",
    })
  })

  test("a button channel gets quick replies; an optional field offers Skip", async () => {
    mocks.start.mockResolvedValue({
      kind: "ask",
      session: session(),
      field: { ...colorField, required: false },
      preface: [],
      retry: false,
    })
    await askForm(props({ channel: "webchat" }))
    const data = (
      mocks.chatQueueAdd.mock.calls[0]?.[1] as {
        data: { quickReplies: { label: string; postback: string }[] }
      }
    ).data
    // Opaque payloads: a Telegram echo never carries an option value.
    expect(data.quickReplies.map((q) => q.postback)).toEqual([
      "askform:0",
      "askform:1",
      "askform:skip",
    ])
  })

  test("a retry prefixes the retry message and returns retry", async () => {
    mocks.start.mockResolvedValue({
      kind: "ask",
      session: session({ attempts: 1 }),
      field: { ...colorField, chat: { retryMessage: "Pick 1 or 2." } },
      preface: [],
      retry: true,
    })
    const out = await askForm(props())
    expect(out.status).toBe("retry")
    const text = (
      mocks.chatQueueAdd.mock.calls[0]?.[1] as { data: { text: string } }
    ).data.text
    expect(text.startsWith("Pick 1 or 2.\n\n")).toBe(true)
  })

  test("a slider / rating question carries its range; the reply is a number (s220c A2-4)", async () => {
    for (const [field, suffix] of [
      [
        {
          key: "stars",
          type: "rating",
          label: "Rate us",
          required: true,
          max: 4,
        },
        "Rate us (1-4)",
      ],
      [
        {
          key: "mood",
          type: "slider",
          label: "Mood",
          required: true,
          min: 0,
          max: 10,
        },
        "Mood (0-10)",
      ],
    ] as const) {
      mocks.chatQueueAdd.mockClear()
      mocks.start.mockResolvedValue({
        kind: "ask",
        session: session(),
        field,
        preface: [],
        retry: false,
      })
      await askForm(props())
      const text = (
        mocks.chatQueueAdd.mock.calls[0]?.[1] as { data: { text: string } }
      ).data.text
      expect(text.startsWith(suffix)).toBe(true)
    }
  })

  test("a date field on a link-capable channel sends the signed picker", async () => {
    mocks.start.mockResolvedValue({
      kind: "ask",
      session: session(),
      field: { key: "when", type: "date", label: "Which day?", required: true },
      preface: [],
      retry: false,
    })
    await askForm(props({ channel: "messenger" }))
    expect(mocks.signToken).toHaveBeenCalledWith(
      expect.objectContaining({
        stepId: "step-1",
        challengeId: "ch-1",
        replyFormat: "date",
      }),
    )
    const qr = (
      mocks.chatQueueAdd.mock.calls[0]?.[1] as {
        data: { quickReplies: { buttonType: string; url: string }[] }
      }
    ).data.quickReplies
    expect(qr[0]?.buttonType).toBe("url")
    expect(qr[0]?.url).toContain(
      "/extensions/datetime-picker?token=signed-token",
    )
  })

  test("a resumed reply is read UNDER the service lock against the question it answers", async () => {
    mocks.findMessageById.mockResolvedValue({
      id: "m-9",
      conversationId: "conv-1",
      messageType: "incoming",
      contentType: "text",
      text: "40.7128, -74.006",
      attachments: [],
    })
    mocks.answer.mockImplementation(async (input) => {
      const text = await input.reply.read({
        key: "where",
        type: "location",
        label: "Where?",
        required: true,
      })
      expect(text).toBe("40.7128,-74.006")
      const photo = await input.reply.read({
        key: "photo",
        type: "image",
        label: "Photo?",
        required: true,
      })
      expect(photo).toBeNull() // a text reply is not a photo
      return { kind: "ignored", reason: "stale" }
    })
    const out = await askForm(
      props({
        ctx: resumed as never,
        triggerMessageId: "m-9",
        triggerMessageCreatedAt: new Date(),
      }),
    )
    expect(out).toEqual({ status: "wait", result: null })
    expect(mocks.answer).toHaveBeenCalledWith(
      expect.objectContaining({
        stepId: "step-1",
        reply: expect.objectContaining({ messageId: "m-9" }),
      }),
    )
    // An ignored reply sends nothing.
    expect(mocks.chatQueueAdd).not.toHaveBeenCalled()
  })

  test("a photo reply becomes its public URL; a picked date its ISO day", async () => {
    mocks.findMessageById.mockResolvedValue({
      id: "m-10",
      conversationId: "conv-1",
      messageType: "incoming",
      contentType: "text",
      text: "",
      attachments: [{ fileType: "image", originPath: "ws/p.jpg" }],
    })
    let photo: unknown
    mocks.answer.mockImplementation(async (input) => {
      photo = await input.reply.read({
        key: "photo",
        type: "image",
        label: "Photo?",
        required: true,
      })
      return { kind: "ignored", reason: "duplicate" }
    })
    await askForm(
      props({
        ctx: resumed as never,
        triggerMessageId: "m-10",
        triggerMessageCreatedAt: new Date(),
      }),
    )
    expect(photo).toBe("https://files.example.org/ws/p.jpg")
  })

  test("a message from another conversation never answers", async () => {
    mocks.findMessageById.mockResolvedValue({
      id: "m-11",
      conversationId: "conv-OTHER",
      messageType: "incoming",
      text: "red",
      attachments: [],
    })
    const out = await askForm(
      props({
        ctx: resumed as never,
        triggerMessageId: "m-11",
        triggerMessageCreatedAt: new Date(),
      }),
    )
    expect(out).toEqual({ status: "wait", result: null })
    expect(mocks.answer).not.toHaveBeenCalled()
  })

  test("completion clears THIS challenge (compare-and-clear) and routes success", async () => {
    mocks.start.mockResolvedValue({
      kind: "completed",
      session: session({ status: "completed" }),
      submission: { id: "sub-1" },
      preface: [],
    })
    const out = await askForm(props())
    expect(out).toEqual({ status: "success", result: "sub-1" })
    expect(mocks.consumeChallenge).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      conversationId: "conv-1",
      stepId: "step-1",
      challengeId: "ch-1",
    })
  })

  test("attempts exhausted routes skip; a missing form routes skip; busy waits", async () => {
    mocks.start.mockResolvedValueOnce({
      kind: "ended",
      session: session({ status: "skipped" }),
      reason: "attempts",
    })
    expect((await askForm(props())).status).toBe("skip")
    mocks.start.mockResolvedValueOnce({
      kind: "unavailable",
      reason: "formNotFound",
    })
    expect((await askForm(props())).status).toBe("skip")
    mocks.start.mockResolvedValueOnce({ kind: "unavailable", reason: "busy" })
    expect((await askForm(props())).status).toBe("wait")
  })

  test("the expiry re-entry routes skip once, and only on the job that re-entered THIS step", async () => {
    const meta = {
      type: "askFormExpired",
      stepId: "step-1",
      formSessionId: "session-1",
    }
    const reentry = { metadata: meta as never, startFromStepId: "step-1" }
    mocks.claimExpiredRoute.mockResolvedValueOnce(true)
    expect((await askForm(props(reentry))).status).toBe("skip")
    expect(mocks.claimExpiredRoute).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sessionId: "session-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      stepId: "step-1",
    })
    mocks.claimExpiredRoute.mockResolvedValueOnce(false)
    expect((await askForm(props(reentry))).status).toBe("wait")
    expect(mocks.start).not.toHaveBeenCalled()
    // The same metadata carried into a later visit (a loop back to this
    // step) is not ours: the step starts a fresh run.
    mocks.start.mockResolvedValueOnce({ kind: "unavailable", reason: "busy" })
    await askForm(props({ metadata: meta as never }))
    expect(mocks.start).toHaveBeenCalledTimes(1)
  })

  test("an undelivered question (failed / timed-out send) is never opened for answers", async () => {
    mocks.start.mockResolvedValue({
      kind: "ask",
      session: session(),
      field: colorField,
      preface: [],
      retry: false,
    })
    mocks.delivered.mockResolvedValueOnce(false)
    await askForm(props())
    expect(mocks.markAsked).not.toHaveBeenCalled()
    expect(mocks.markUndelivered).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sessionId: "session-1",
      challengeId: "ch-1",
    })
  })

  test("a send that throws marks the question undelivered too", async () => {
    mocks.start.mockResolvedValue({
      kind: "ask",
      session: session(),
      field: colorField,
      preface: [],
      retry: false,
    })
    mocks.chatQueueAdd.mockRejectedValueOnce(new Error("redis down"))
    expect(await askForm(props())).toEqual({ status: "wait", result: null })
    expect(mocks.markUndelivered).toHaveBeenCalled()
    expect(mocks.markAsked).not.toHaveBeenCalled()
  })

  test("a start that replaced a run elsewhere clears that conversation's challenge", async () => {
    mocks.start.mockResolvedValue({
      kind: "ask",
      session: session(),
      field: colorField,
      preface: [],
      retry: false,
      replaced: {
        conversationId: "conv-A",
        stepId: "step-9",
        challengeId: "ch-A",
      },
    })
    await askForm(props())
    expect(mocks.consumeChallenge).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      conversationId: "conv-A",
      stepId: "step-9",
      challengeId: "ch-A",
    })
  })

  test("a picker submit answers by challenge id with the picked value", async () => {
    mocks.answer.mockResolvedValue({ kind: "ignored", reason: "stale" })
    await askForm(
      props({
        metadata: {
          type: "getUserDataWebviewSelection",
          stepId: "step-1",
          challengeId: "ch-1",
          selectedValue: "2026-10-01T00:00:00.000Z",
        } as never,
        startFromStepId: "step-1",
      }),
    )
    expect(mocks.answer).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-1",
        contactInboxId: "ci-1",
        reply: { challengeId: "ch-1", text: "2026-10-01T00:00:00.000Z" },
      }),
    )
  })

  test("a thrown service error parks the step (wait), never re-sends", async () => {
    mocks.start.mockRejectedValue(new Error("db down"))
    expect(await askForm(props())).toEqual({ status: "wait", result: null })
    expect(mocks.chatQueueAdd).not.toHaveBeenCalled()
  })
})
