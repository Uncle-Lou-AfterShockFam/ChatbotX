// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

// ── analytics mock (the key subject of this test) ──────────────────────────
const createRecipient = vi.fn().mockResolvedValue({ token: "test-token-xyz" })
const markDelivered = vi.fn().mockResolvedValue(undefined)
const markFailed = vi.fn().mockResolvedValue(undefined)

vi.mock("@chatbotx.io/analytics", () => ({
  emailTopicAnalyticsService: { createRecipient, markDelivered, markFailed },
}))

// ── business services ───────────────────────────────────────────────────────
const runAction = vi.fn().mockResolvedValue(undefined)

vi.mock("@chatbotx.io/business", () => ({
  buildContext: vi.fn().mockResolvedValue({ ctx: true }),
  buildUnsubscribeUrl: vi
    .fn()
    .mockResolvedValue("https://app.test/unsubscribe?token=unsub"),
  contactService: {
    findBy: vi.fn().mockResolvedValue({ emailOptIn: true }),
  },
  inboxService: { find: vi.fn().mockResolvedValue(undefined) },
  integrationSmtpService: {
    find: vi.fn().mockResolvedValue({
      id: "smtp-1",
      name: "SMTP",
      auth: {
        authType: "custom",
        host: "smtp.test",
        port: 587,
        fromAddress: "from@test.com",
      },
    }),
  },
  resolveTenantSettings: vi
    .fn()
    .mockResolvedValue({ appUrl: "https://app.test" }),
  signEmailClickUrl: vi.fn().mockResolvedValue("signed-token"),
  workspaceService: {
    findById: vi.fn().mockResolvedValue({ id: "ws-1", name: "WS" }),
  },
}))

vi.mock("@chatbotx.io/integration-smtp", () => ({
  integration: { runAction },
  smtpAuthSchema: {
    parse: vi.fn((v) => v),
  },
}))

const renderDynamicEmailHtmlMock = vi.fn().mockReturnValue("<html/>")

vi.mock("@chatbotx.io/mail/dynamic", () => ({
  renderDynamicEmailHtml: renderDynamicEmailHtmlMock,
}))

vi.mock("@chatbotx.io/variables", () => ({
  contactVariableService: {
    getAll: vi.fn().mockResolvedValue([]),
    // {{evil}} stands for a contact field whose value carries markup.
    replaceAll: vi.fn(({ text }: { text: string }) =>
      Promise.resolve(
        text.replaceAll(
          "{{evil}}",
          '<a href="https://phish.test/steal">Verify</a>',
        ),
      ),
    ),
    // s227b: subject/preheader/legacy text resolve names, then render Liquid.
    resolveMapping: vi.fn(({ text }: { text: string }) =>
      Promise.resolve(
        text.includes("{{evil}}")
          ? { evil: '<a href="https://phish.test/steal">Verify</a>' }
          : { first_name: "Jane" },
      ),
    ),
  },
}))

vi.mock("../../src/lib/convert-button", () => ({
  resolveButtonUrl: vi.fn().mockReturnValue("https://resolved-url.com/page"),
}))

vi.mock("../../src/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}))

const renderStepDocumentMock = vi.fn()
const prepareStepDocumentMock = vi.fn()
const { ContentError } = vi.hoisted(() => ({
  ContentError: class extends Error {},
}))
vi.mock("../src/integration/handlers/send-email-document", () => ({
  EmailContentError: ContentError,
  prepareStepDocument: (...args: unknown[]) => prepareStepDocumentMock(...args),
  renderStepDocument: (...args: unknown[]) => renderStepDocumentMock(...args),
}))

// s222b: the email line (bulktext) transport; its own logic is covered by
// send-email-line.test.ts, here only the branch and its ordering.
const resolveEmailLineMock = vi.fn()
const buildLineEmailMock = vi.fn()
vi.mock("../src/integration/handlers/send-email-line", () => ({
  resolveEmailLine: (...args: unknown[]) => resolveEmailLineMock(...args),
  buildLineEmail: (...args: unknown[]) => buildLineEmailMock(...args),
  LINE_EMAIL_LIMITS: {
    subject: 200,
    htmlBytes: 524_288,
    textBytes: 131_072,
    threadKeys: 20,
  },
}))
const lineRunAction = vi.fn()
const resolveLineContext = vi.fn()
vi.mock("../src/services/integrations", () => ({
  resolveIntegrationContextFromContactInbox: (...args: unknown[]) =>
    resolveLineContext(...args),
}))

// s224b: send-time suppression; the real isSendSuppressed runs over this lookup.
const isSuppressedMock = vi.fn()
vi.mock("@chatbotx.io/business/email-suppression", () => ({
  emailSuppressionService: {
    isSuppressed: (...args: unknown[]) => isSuppressedMock(...args),
  },
}))

// s226b: the line's mail store, as an in-memory fake (its SQL is covered by
// the business real-DB suite). Rows are per (contact, line); `latest` = the
// newest in scope.
type FakeMail = {
  direction: "outgoing" | "incoming"
  messageKey: string | null
  messageId: string | null
  subject: string
  parents: string[]
  lineInboxId: string
  sequenceId?: string | null
  broadcastId?: string | null
  flowId?: string | null
}
const mails: FakeMail[] = []
const recordOutgoing = vi.fn((p: Record<string, unknown>) => {
  if (
    mails.some(
      (m) => m.messageKey === p.messageKey && m.lineInboxId === p.lineInboxId,
    )
  ) {
    return Promise.resolve(null)
  }
  const { tx: _tx, ...fields } = p
  const row = {
    direction: "outgoing" as const,
    messageId: null,
    ...(fields as Omit<FakeMail, "direction" | "messageId">),
  }
  mails.push(row)
  return Promise.resolve(row)
})
const lineLocks = vi.fn()
const forgetOutgoing = vi.fn((p: Record<string, unknown>) => {
  const i = mails.findIndex(
    (m) => m.messageKey === p.messageKey && m.lineInboxId === p.lineInboxId,
  )
  if (i >= 0) {
    mails.splice(i, 1)
  }
  return Promise.resolve()
})
vi.mock("@chatbotx.io/business/email-thread", async () => {
  const actual = await vi.importActual<
    typeof import("@chatbotx.io/business/email-thread")
  >("@chatbotx.io/business/email-thread")
  return {
    isCitableMsgId: actual.isCitableMsgId,
    emailThreadMailService: {
      withLineLock: (line: unknown, fn: (tx: unknown) => unknown) => {
        lineLocks(line)
        return fn({ tx: true })
      },
      recordOutgoing: (p: Record<string, unknown>) => recordOutgoing(p),
      forgetOutgoing: (p: Record<string, unknown>) => forgetOutgoing(p),
      findByKey: async (p: { lineInboxId: string; messageKey: string }) =>
        mails.find(
          (m) =>
            m.lineInboxId === p.lineInboxId && m.messageKey === p.messageKey,
        ) ?? null,
      latest: async (p: {
        lineInboxId: string
        scope: Record<string, string>
      }) =>
        [...mails]
          .reverse()
          .find(
            (m) =>
              m.lineInboxId === p.lineInboxId &&
              Object.entries(p.scope).every(
                ([k, v]) => (m as Record<string, unknown>)[k] === v,
              ),
          ) ?? null,
    },
  }
})
// s229b: the line's senders. Default: none (the legacy env account).
const pickForNewThread = vi.fn(async (): Promise<string | null> => null)
const assertThreadSender = vi.fn(async () => undefined)
vi.mock("@chatbotx.io/business/email-sender", async () => {
  const actual = await vi.importActual<
    typeof import("@chatbotx.io/business/email-sender")
  >("@chatbotx.io/business/email-sender")
  return {
    EmailSenderUnavailableError: actual.EmailSenderUnavailableError,
    emailSenderService: {
      pickForNewThread: (...a: unknown[]) => pickForNewThread(...(a as [])),
      assertThreadSender: (...a: unknown[]) => assertThreadSender(...(a as [])),
    },
  }
})
const removeEnrollment = vi.fn()
// s236: the enrolment cycle a sequence line mail gates itself on (null = no
// stop-on-reply gate, the default every older test runs under).
const findReplyGate = vi.fn()
vi.mock("@chatbotx.io/business/contact-sequence", () => ({
  contactSequenceService: {
    removeContactSequencesForContact: (...args: unknown[]) =>
      removeEnrollment(...args),
    findReplyGate: (...args: unknown[]) => findReplyGate(...args),
  },
}))

const { sendEmail, isContactsOwnAddress } = await import(
  "../../src/integration/handlers/send-email"
)
const { integrationSmtpService } = await import("@chatbotx.io/business")

// ── shared fixture ──────────────────────────────────────────────────────────
function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    conversation: {
      id: "conv-1",
      workspaceId: "ws-1",
      contactId: "contact-1",
    },
    contactInbox: { id: "ci-1", inboxId: "inbox-1" },
    flowVersion: { flowId: "flow-1" },
    step: {
      integrationSmtpId: "smtp-1",
      to: "user@example.com",
      subject: "Hello",
      preheader: "preview",
      from: "from@test.com",
      elements: [],
      topicId: "topic-1",
      ...overrides,
    },
    metadata: {},
  }
}

beforeEach(() => {
  findReplyGate.mockReset()
  findReplyGate.mockResolvedValue(null)
  isSuppressedMock.mockReset()
  isSuppressedMock.mockResolvedValue(false)
  createRecipient.mockResolvedValue({ token: "test-token-xyz" })
  runAction.mockResolvedValue(undefined)
  prepareStepDocumentMock.mockResolvedValue({ prepared: true })
  renderDynamicEmailHtmlMock.mockReturnValue("<html/>")
  resolveEmailLineMock.mockResolvedValue({
    id: "ci-line",
    inboxId: "line-1",
    sourceId: "jane@example.com",
  })
  buildLineEmailMock.mockImplementation(async (mail) => ({
    ...mail,
    attachments: [],
  }))
  lineRunAction.mockResolvedValue({ messageIds: ["outbox:1"] })
  resolveLineContext.mockResolvedValue({
    integration: { runAction: lineRunAction },
    ctx: { line: true },
  })
})

describe("with topicId", () => {
  test("calls createRecipient with conversation identifiers and resolved email", async () => {
    await sendEmail(makeProps() as never)
    expect(createRecipient).toHaveBeenCalledOnce()
    expect(createRecipient).toHaveBeenCalledWith(
      expect.objectContaining({
        topicId: "topic-1",
        workspaceId: "ws-1",
        contactId: "contact-1",
        conversationId: "conv-1",
        contactInboxId: "ci-1",
        email: "user@example.com",
      }),
    )
  })

  test("embeds token in tracking pixel URL", async () => {
    await sendEmail(makeProps() as never)
    const callArg = renderDynamicEmailHtmlMock.mock.calls[0]?.[0] as {
      elements: { type: string; url?: string }[]
    }
    const pixel = callArg?.elements.find((el) => el.type === "image")
    expect(pixel?.url).toContain("r=test-token-xyz")
    expect(pixel?.url).toContain("/email-topic/open")
  })

  test("calls markDelivered with token on send success", async () => {
    await sendEmail(makeProps() as never)
    expect(markDelivered).toHaveBeenCalledOnce()
    expect(markDelivered).toHaveBeenCalledWith("test-token-xyz")
    expect(markFailed).not.toHaveBeenCalled()
  })

  test("calls markFailed with token when runAction throws", async () => {
    runAction.mockRejectedValue(new Error("SMTP error"))
    await sendEmail(makeProps() as never)
    expect(markFailed).toHaveBeenCalledOnce()
    expect(markFailed).toHaveBeenCalledWith("test-token-xyz")
    expect(markDelivered).not.toHaveBeenCalled()
  })
})

describe("without topicId", () => {
  test("does not call any analytics methods", async () => {
    await sendEmail(makeProps({ topicId: undefined }) as never)
    expect(createRecipient).not.toHaveBeenCalled()
    expect(markDelivered).not.toHaveBeenCalled()
    expect(markFailed).not.toHaveBeenCalled()
  })

  test("still sends the email", async () => {
    await sendEmail(makeProps({ topicId: undefined }) as never)
    expect(runAction).toHaveBeenCalledOnce()
  })
})

describe("s220b: text part, List-Unsubscribe, tracked text links", () => {
  const withText = (text: string) =>
    makeProps({ elements: [{ id: "1", type: "text", text }] }) as never

  test("sends a text part and the RFC 8058 one-click headers", async () => {
    await sendEmail(withText("<p>Hi there</p>"))
    const args = runAction.mock.calls[0]?.[1] as {
      text: string
      headers: Record<string, string>
    }
    expect(args.text).toBe("Hi there")
    expect(args.headers).toEqual({
      "List-Unsubscribe":
        "<https://app.test/unsubscribe/one-click?token=unsub>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    })
  })

  test("a link typed into text is tracked; the unsubscribe link is not", async () => {
    await sendEmail(
      withText(
        '<p><a href="https://x.test/a">a</a> <a href="<<unsubscribeUrl>>">stop</a></p>',
      ),
    )
    const html = renderDynamicEmailHtmlMock.mock.calls.at(-1)?.[0] as {
      elements: { type: string; text?: string }[]
    }
    const text = html.elements.find((el) => el.type === "text")?.text ?? ""
    expect(text).toContain(
      'href="https://app.test/email-topic/click?r=test-token-xyz&amp;u=signed-token"',
    )
    expect(text).toContain('href="https://app.test/unsubscribe?token=unsub"')
  })

  test("without a topic nothing in text is rewritten", async () => {
    await sendEmail(
      makeProps({
        topicId: undefined,
        elements: [
          { id: "1", type: "text", text: '<a href="https://x.test/a">a</a>' },
        ],
      }) as never,
    )
    const html = renderDynamicEmailHtmlMock.mock.calls.at(-1)?.[0] as {
      elements: { type: string; text?: string }[]
    }
    expect(html.elements[0]?.text).toBe('<a href="https://x.test/a">a</a>')
  })
})

test("s220b skeptic CRITICAL: a link injected through a contact field is never signed", async () => {
  await sendEmail(
    makeProps({
      elements: [
        {
          id: "1",
          type: "text",
          text: '<p>{{evil}} <a href="https://x.test/a">ours</a></p>',
        },
      ],
    }) as never,
  )
  const html = renderDynamicEmailHtmlMock.mock.calls.at(-1)?.[0] as {
    elements: { type: string; text?: string }[]
  }
  const text = html.elements.find((el) => el.type === "text")?.text ?? ""
  expect(text).toContain('href="https://phish.test/steal"')
  expect(text.match(/email-topic\/click/g)?.length).toBe(1)
})

describe("s220b: broadcast attribution", () => {
  test("a broadcast's send carries its broadcastId into the recipient row", async () => {
    await sendEmail({
      ...makeProps(),
      metadata: {
        type: "broadcast",
        broadcastId: "b-1",
        contactInboxId: "ci-1",
      },
    } as never)
    expect(createRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ broadcastId: "b-1" }),
    )
  })

  test("the recipient is keyed by the broadcast's own contactInboxId", async () => {
    await sendEmail({
      ...makeProps(),
      metadata: {
        type: "broadcast",
        broadcastId: "b-1",
        contactInboxId: "ci-broadcast",
      },
    } as never)
    expect(createRecipient).toHaveBeenLastCalledWith(
      expect.objectContaining({ contactInboxId: "ci-broadcast" }),
    )
  })

  test("a stats error after a sent mail never marks it failed", async () => {
    markDelivered.mockRejectedValueOnce(new Error("db blip"))
    markFailed.mockClear()
    await sendEmail(makeProps() as never)
    expect(runAction).toHaveBeenCalled()
    expect(markFailed).not.toHaveBeenCalled()
  })

  test("s223b: a broadcast's document send scopes the attachment cache to its broadcast; other sends do not", async () => {
    await sendEmail({
      ...makeProps({ templateId: "77", elements: [] }),
      metadata: {
        type: "broadcast",
        broadcastId: "11",
        contactInboxId: "ci-1",
      },
    } as never)
    expect(prepareStepDocumentMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ broadcastId: "11" }),
    )
    await sendEmail({
      ...makeProps({ templateId: "77", elements: [] }),
      metadata: {},
    } as never)
    expect(prepareStepDocumentMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ broadcastId: undefined }),
    )
    await sendEmail({
      ...makeProps({ templateId: "77", elements: [] }),
      metadata: { type: "broadcast", contactInboxId: "ci-1" },
    } as never)
    expect(prepareStepDocumentMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ broadcastId: undefined }),
    )
  })

  test("a send outside a broadcast has no broadcastId", async () => {
    await sendEmail({ ...makeProps(), metadata: {} } as never)
    expect(createRecipient).toHaveBeenLastCalledWith(
      expect.objectContaining({ broadcastId: null }),
    )
  })
})

describe("s220b phase 2b: template / document steps", () => {
  test("a template step sends the rendered document, not the elements path", async () => {
    renderStepDocumentMock.mockResolvedValueOnce({
      html: "<html>doc</html>",
      text: "doc",
    })
    await sendEmail(makeProps({ templateId: "77", elements: [] }) as never)
    const args = runAction.mock.calls.at(-1)?.[1] as {
      html: string
      text: string
    }
    expect(args.html).toBe("<html>doc</html>")
    expect(args.text).toBe("doc")
  })

  test("s221b: the document's attachments reach sendMail as buffered parts", async () => {
    const attachments = [
      {
        filename: "a.pdf",
        content: Buffer.from("%PDF"),
        contentType: "application/pdf",
        key: "public/space/ws-1/media/a.pdf",
      },
    ]
    renderStepDocumentMock.mockResolvedValueOnce({
      html: "<html>doc</html>",
      text: "doc",
      attachments,
    })
    await sendEmail(makeProps({ templateId: "77", elements: [] }) as never)
    const args = runAction.mock.calls.at(-1)?.[1] as {
      attachments: unknown
    }
    // s222b: the storage key is for the email line only; SMTP gets the part.
    expect(args.attachments).toEqual([
      {
        filename: "a.pdf",
        content: Buffer.from("%PDF"),
        contentType: "application/pdf",
      },
    ])
  })

  test("an unrenderable template fails closed: nothing is sent, the topic row is marked failed", async () => {
    renderStepDocumentMock.mockRejectedValueOnce(
      new ContentError("Email template not found"),
    )
    runAction.mockClear()
    await sendEmail(makeProps({ templateId: "404", elements: [] }) as never)
    expect(runAction).not.toHaveBeenCalled()
    expect(markFailed).toHaveBeenCalledWith("test-token-xyz")
  })
})

test("s220b review: a transient render error propagates (queue retry), nothing sent", async () => {
  renderStepDocumentMock.mockRejectedValueOnce(new Error("connection reset"))
  runAction.mockClear()
  await expect(
    sendEmail(makeProps({ templateId: "77", elements: [] }) as never),
  ).rejects.toThrow("connection reset")
  expect(runAction).not.toHaveBeenCalled()
})

describe("s227b H3: subject, preheader and legacy text are Liquid", () => {
  const OWNER =
    "Hi {% if first_name %}{{first_name}}{% else %}{{company}} Team{% endif %}"

  test("the subject renders the else branch when first_name is missing", async () => {
    const { contactVariableService } = await import("@chatbotx.io/variables")
    vi.mocked(contactVariableService.resolveMapping).mockResolvedValueOnce({
      company: "Acme",
    })
    runAction.mockClear()
    await sendEmail(makeProps({ subject: OWNER }) as never)
    const args = runAction.mock.calls.at(-1)?.[1] as { subject: string }
    expect(args.subject).toBe("Hi Acme Team")
  })

  test("the subject renders the if branch when first_name is set", async () => {
    runAction.mockClear()
    await sendEmail(makeProps({ subject: OWNER }) as never)
    const args = runAction.mock.calls.at(-1)?.[1] as { subject: string }
    expect(args.subject).toBe("Hi Jane")
  })

  test.each([
    ["subject", { subject: "Hi {% if first_name %}" }],
    ["preheader", { preheader: '{% include "x" %}' }],
    [
      "legacy text",
      { elements: [{ id: "1", type: "text", text: "{% for %}" }] },
    ],
  ])("an invalid %s template fails closed: counted, marked failed, never sent", async (_label, override) => {
    createRecipient.mockClear()
    markFailed.mockClear()
    runAction.mockClear()
    await sendEmail(makeProps(override) as never)
    expect(runAction).not.toHaveBeenCalled()
    expect(markFailed).toHaveBeenCalledWith("test-token-xyz")
  })
})

describe("s221b skeptic HIGH: document reads happen before the tracking row", () => {
  test("a transient read error retries with NO recipient row written (no double count)", async () => {
    prepareStepDocumentMock.mockRejectedValueOnce(new Error("ECONNRESET"))
    createRecipient.mockClear()
    runAction.mockClear()
    await expect(
      sendEmail(makeProps({ templateId: "77", elements: [] }) as never),
    ).rejects.toThrow("ECONNRESET")
    expect(createRecipient).not.toHaveBeenCalled()
    expect(runAction).not.toHaveBeenCalled()
  })

  test("unusable content is still counted once, then marked failed; nothing sent", async () => {
    prepareStepDocumentMock.mockRejectedValueOnce(
      new ContentError("attachment 8 is missing"),
    )
    createRecipient.mockClear()
    markFailed.mockClear()
    runAction.mockClear()
    await sendEmail(makeProps({ templateId: "77", elements: [] }) as never)
    expect(createRecipient).toHaveBeenCalledOnce()
    expect(markFailed).toHaveBeenCalledWith("test-token-xyz")
    expect(runAction).not.toHaveBeenCalled()
    expect(renderStepDocumentMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ prepared: undefined }),
    )
  })

  test("the prepared document is rendered with the new token", async () => {
    renderStepDocumentMock.mockResolvedValueOnce({ html: "<p/>", text: "" })
    await sendEmail(makeProps({ templateId: "77", elements: [] }) as never)
    expect(renderStepDocumentMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prepared: { prepared: true },
        token: "test-token-xyz",
      }),
    )
  })

  test("a legacy elements step never prepares a document", async () => {
    prepareStepDocumentMock.mockClear()
    await sendEmail(makeProps() as never)
    expect(prepareStepDocumentMock).not.toHaveBeenCalled()
  })
})

const UUID_REF = /^email:u:[0-9a-f-]{36}$/
const MINTED_KEY = /^bt\.[A-Za-z0-9_-]{20}$/

describe("s222b B2 phase 4: a step with an email line sends through bulktext, not SMTP", () => {
  const lineStep = { lineInboxId: "line-1", templateId: "77", elements: [] }

  beforeEach(() => {
    vi.mocked(integrationSmtpService.find).mockClear()
    runAction.mockClear()
    createRecipient.mockClear()
    markFailed.mockClear()
    markDelivered.mockClear()
    renderStepDocumentMock.mockResolvedValue({
      html: "<p>doc</p>",
      text: "doc",
      attachments: [],
    })
  })

  test("the rendered mail goes to the line with the unsubscribe pair and a token ref; the recipient is the line address; the QUEUED send stays open for the line's status", async () => {
    await sendEmail(makeProps(lineStep) as never)
    expect(integrationSmtpService.find).not.toHaveBeenCalled()
    expect(runAction).not.toHaveBeenCalled()
    expect(resolveEmailLineMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      contactId: "contact-1",
      lineInboxId: "line-1",
    })
    expect(createRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ email: "jane@example.com" }),
    )
    expect(buildLineEmailMock).toHaveBeenCalledWith({
      appUrl: "https://app.test",
      subject: "Hello",
      html: "<p>doc</p>",
      text: "doc",
      headers: {
        "List-Unsubscribe":
          "<https://app.test/unsubscribe/one-click?token=unsub>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      attachments: [],
      format: "html",
      // s226b: every line mail is keyed (a future thread parent).
      messageKey: expect.stringMatching(MINTED_KEY),
      threadKeys: [],
      replyTo: [],
      // s229b: a line without senders = the env account (buildLineEmail
      // then leaves the key out).
      sender: null,
    })
    expect(resolveLineContext).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      contactInbox: expect.objectContaining({ id: "ci-line" }),
    })
    expect(lineRunAction).toHaveBeenCalledWith("sendEmail", {
      ctx: { line: true },
      contact: { id: "ci-line", sourceId: "jane@example.com" },
      email: expect.objectContaining({ subject: "Hello", html: "<p>doc</p>" }),
      ref: "email:t:test-token-xyz",
    })
    // Enqueued is not delivered: the line's own status settles it.
    expect(markDelivered).not.toHaveBeenCalled()
    expect(markFailed).not.toHaveBeenCalled()
  })

  test("a line the contact cannot be reached on is resolved BEFORE the tracking row: counted once, failed, nothing rendered or sent", async () => {
    resolveEmailLineMock.mockRejectedValueOnce(
      new ContentError("contact contact-1 has no email address on line line-1"),
    )
    renderStepDocumentMock.mockClear()
    prepareStepDocumentMock.mockClear()
    await sendEmail(makeProps(lineStep) as never)
    expect(prepareStepDocumentMock).not.toHaveBeenCalled()
    expect(createRecipient).toHaveBeenCalledOnce()
    expect(markFailed).toHaveBeenCalledWith("test-token-xyz")
    expect(renderStepDocumentMock).not.toHaveBeenCalled()
    expect(lineRunAction).not.toHaveBeenCalled()
  })

  test("a transient line lookup error retries with NO tracking row written", async () => {
    resolveEmailLineMock.mockRejectedValueOnce(new Error("ECONNRESET"))
    await expect(sendEmail(makeProps(lineStep) as never)).rejects.toThrow(
      "ECONNRESET",
    )
    expect(createRecipient).not.toHaveBeenCalled()
  })

  test("a mail past the line caps, or a line refusal, marks the send failed (never delivered)", async () => {
    buildLineEmailMock.mockRejectedValueOnce(
      new ContentError("the rendered email exceeds 524288 bytes"),
    )
    lineRunAction.mockClear()
    await sendEmail(makeProps(lineStep) as never)
    expect(lineRunAction).not.toHaveBeenCalled()
    expect(markFailed).toHaveBeenCalledTimes(1)

    lineRunAction.mockRejectedValueOnce(
      new Error("bulktext refused the send (media-fetch)"),
    )
    await sendEmail(makeProps(lineStep) as never)
    expect(markFailed).toHaveBeenCalledTimes(2)
    expect(markDelivered).not.toHaveBeenCalled()
  })

  test("a legacy elements step can use the line too (brand falls back to the workspace)", async () => {
    await sendEmail(makeProps({ lineInboxId: "line-1" }) as never)
    expect(runAction).not.toHaveBeenCalled()
    expect(lineRunAction).toHaveBeenCalledWith(
      "sendEmail",
      expect.objectContaining({ ref: "email:t:test-token-xyz" }),
    )
  })

  test("no topic: the ref is still unique per send", async () => {
    await sendEmail(makeProps({ ...lineStep, topicId: undefined }) as never)
    const ref = (lineRunAction.mock.calls.at(-1)?.[1] as { ref: string }).ref
    expect(ref).toMatch(UUID_REF)
  })
})

test("s222b Codex probe: bad stored SMTP auth throws BEFORE the tracking row (no orphan recipient per retry)", async () => {
  const { smtpAuthSchema } = await import("@chatbotx.io/integration-smtp")
  vi.mocked(smtpAuthSchema.parse).mockImplementationOnce(() => {
    throw new Error("host: required")
  })
  createRecipient.mockClear()
  await expect(sendEmail(makeProps() as never)).rejects.toThrow(
    "host: required",
  )
  expect(createRecipient).not.toHaveBeenCalled()
})

describe("personal form links in email (s220c)", () => {
  test("only mail to the contact's OWN address may carry them", () => {
    expect(isContactsOwnAddress("Jane@Example.com ", "jane@example.com")).toBe(
      true,
    )
    expect(isContactsOwnAddress("boss@example.com", "jane@example.com")).toBe(
      false,
    )
    expect(
      isContactsOwnAddress(
        "jane@example.com, boss@example.com",
        "jane@example.com",
      ),
    ).toBe(false)
    expect(isContactsOwnAddress("", "")).toBe(false)
    expect(isContactsOwnAddress("jane@example.com", null)).toBe(false)
    // a stored "email" that is really a list never passes, even when equal
    const list = "jane@example.com, other@example.com"
    expect(isContactsOwnAddress(list, list)).toBe(false)
    expect(
      isContactsOwnAddress("jane@example.com;x@y.z", "jane@example.com;x@y.z"),
    ).toBe(false)
  })

  test("an email LINE send is judged by the line's address, not step.to (Codex review s220c)", async () => {
    const { contactVariableService } = await import("@chatbotx.io/variables")
    const getAll = vi.mocked(contactVariableService.getAll)
    const resolveMapping = vi.mocked(contactVariableService.resolveMapping)
    for (const [lineAddress, expected] of [
      ["other@example.com", false],
      ["jane@example.com", true],
    ] as const) {
      getAll.mockResolvedValueOnce({
        contact: { email: "jane@example.com" },
      } as never)
      resolveEmailLineMock.mockResolvedValueOnce({
        id: "ci-line",
        inboxId: "line-1",
        sourceId: lineAddress,
      })
      resolveMapping.mockClear()
      await sendEmail(
        makeProps({
          to: "jane@example.com",
          lineInboxId: "line-1",
          templateId: "77",
          subject: "Hi {{first_name}}",
        }) as never,
      )
      const subjectCall = resolveMapping.mock.calls.find(
        ([arg]) => (arg as { text: string }).text === "{{first_name}}",
      )?.[0] as { variables: { personalLinks?: boolean } }
      expect(subjectCall.variables.personalLinks).toBe(expected)
    }
  })

  test("the body is resolved with the opt-in only when the recipient is the contact", async () => {
    const { contactVariableService } = await import("@chatbotx.io/variables")
    const getAll = vi.mocked(contactVariableService.getAll)
    const resolveMapping = vi.mocked(contactVariableService.resolveMapping)
    for (const [to, expected] of [
      ["jane@example.com", true],
      ["boss@example.com", false],
    ] as const) {
      getAll.mockResolvedValueOnce({
        contact: { email: "jane@example.com" },
      } as never)
      resolveMapping.mockClear()
      await sendEmail(makeProps({ to, subject: "Hi {{first_name}}" }) as never)
      const subjectCall = resolveMapping.mock.calls.find(
        ([arg]) => (arg as { text: string }).text === "{{first_name}}",
      )?.[0] as { variables: { personalLinks?: boolean } }
      expect(subjectCall.variables.personalLinks).toBe(expected)
    }
  })
})

describe("s224b outreach B-1: a suppressed recipient is never handed off", () => {
  const lineStep = { lineInboxId: "line-1", templateId: "77", elements: [] }

  beforeEach(() => {
    runAction.mockClear()
    lineRunAction.mockClear()
    createRecipient.mockClear()
    markFailed.mockClear()
    markDelivered.mockClear()
    prepareStepDocumentMock.mockClear()
    renderStepDocumentMock.mockResolvedValue({
      html: "<p>doc</p>",
      text: "doc",
      attachments: [],
    })
  })

  test("SMTP: a listed recipient is counted, marked failed as suppressed, and never sent", async () => {
    isSuppressedMock.mockResolvedValue(true)
    await sendEmail(makeProps() as never)
    expect(isSuppressedMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      address: "user@example.com",
    })
    expect(createRecipient).toHaveBeenCalledOnce()
    expect(markFailed).toHaveBeenCalledWith("test-token-xyz", "suppressed")
    expect(runAction).not.toHaveBeenCalled()
    expect(markDelivered).not.toHaveBeenCalled()
  })

  test("line: the check runs on the LINE address, before any content is read or sent", async () => {
    isSuppressedMock.mockImplementation(
      async ({ address }: { address: string }) =>
        address === "jane@example.com",
    )
    await sendEmail(makeProps(lineStep) as never)
    expect(isSuppressedMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      address: "jane@example.com",
    })
    expect(prepareStepDocumentMock).not.toHaveBeenCalled()
    expect(lineRunAction).not.toHaveBeenCalled()
    expect(markFailed).toHaveBeenCalledWith("test-token-xyz", "suppressed")
  })

  test("an untracked (no topic) suppressed send writes nothing and sends nothing", async () => {
    isSuppressedMock.mockResolvedValue(true)
    await sendEmail(makeProps({ topicId: undefined }) as never)
    expect(createRecipient).not.toHaveBeenCalled()
    expect(markFailed).not.toHaveBeenCalled()
    expect(runAction).not.toHaveBeenCalled()
  })

  test("one listed address in a multi-address `to` (with display names) refuses the whole send", async () => {
    isSuppressedMock.mockImplementation(
      async ({ address }: { address: string }) => address === "b@blocked.com",
    )
    await sendEmail(
      makeProps({ to: "a@ok.com, Bee <b@blocked.com>; c@ok.com" }) as never,
    )
    expect(isSuppressedMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      address: "b@blocked.com",
    })
    expect(runAction).not.toHaveBeenCalled()
    expect(markFailed).toHaveBeenCalledWith("test-token-xyz", "suppressed")
  })

  test("a quoted display name with a comma still sends (the regression the s224b probes found)", async () => {
    await sendEmail(
      makeProps({ to: '"Doe, Jane" <jane@example.com>' }) as never,
    )
    expect(isSuppressedMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      address: "jane@example.com",
    })
    expect(runAction).toHaveBeenCalledOnce()
  })

  test("a group or a second angle address cannot hide a listed recipient", async () => {
    isSuppressedMock.mockImplementation(
      async ({ address }: { address: string }) => address === "bob@blocked.com",
    )
    for (const to of [
      "Team:bob@blocked.com;",
      "<bob@blocked.com> <alice@allowed.com>",
      '"bob"@blocked.com',
    ]) {
      runAction.mockClear()
      await sendEmail(makeProps({ to }) as never)
      expect(runAction, to).not.toHaveBeenCalled()
    }
  })

  test("an empty or unusable `to` fails closed (no lookup needed, nothing sent)", async () => {
    for (const to of ["", " , ; ", new Array(51).fill("a@b.com").join(",")]) {
      runAction.mockClear()
      isSuppressedMock.mockClear()
      await sendEmail(makeProps({ to }) as never)
      expect(isSuppressedMock).not.toHaveBeenCalled()
      expect(runAction).not.toHaveBeenCalled()
    }
  })

  test("a failed suppression lookup propagates (the job retries): no tracking row, no send", async () => {
    isSuppressedMock.mockRejectedValue(new Error("db down"))
    await expect(sendEmail(makeProps() as never)).rejects.toThrow("db down")
    expect(createRecipient).not.toHaveBeenCalled()
    expect(runAction).not.toHaveBeenCalled()
  })

  test("an unlisted recipient still sends (the check does not change the happy path)", async () => {
    await sendEmail(makeProps() as never)
    expect(runAction).toHaveBeenCalledOnce()
    expect(markDelivered).toHaveBeenCalledWith("test-token-xyz")
  })
})

describe("s225b/s226b outreach B-1: line mail is keyed and recorded; the thread mode picks its parent", () => {
  const textStep = {
    lineInboxId: "line-1",
    templateId: "77",
    elements: [],
    format: "text",
  }
  const seqMeta = {
    type: "sequenceSchedule",
    sequenceId: "555",
    sequenceStepId: "1",
    dispatchId: "d",
    contactInboxId: "ci-1",
  }
  const props = (
    step: Record<string, unknown>,
    metadata: unknown = seqMeta,
  ) => ({ ...makeProps(step), metadata })
  const sent = (i: number) => buildLineEmailMock.mock.calls[i]?.[0]
  const out = (over: Partial<FakeMail>): FakeMail => ({
    direction: "outgoing",
    messageKey: "bt.root-000001",
    messageId: null,
    subject: "Saturday",
    parents: [],
    lineInboxId: "line-1",
    sequenceId: "555",
    ...over,
  })

  beforeEach(() => {
    mails.length = 0
    pickForNewThread.mockReset()
    pickForNewThread.mockResolvedValue(null)
    assertThreadSender.mockReset()
    assertThreadSender.mockResolvedValue(undefined)
    recordOutgoing.mockClear()
    lineLocks.mockClear()
    removeEnrollment.mockReset()
    buildLineEmailMock.mockClear()
    lineRunAction.mockClear()
    createRecipient.mockClear()
    markFailed.mockClear()
    renderStepDocumentMock.mockReset()
    renderStepDocumentMock.mockResolvedValue({
      html: "<p>doc</p>",
      text: "doc",
      attachments: [],
    })
  })

  test("the first text step: no token, no html, a fresh key RECORDED (with its sequence, flow) before the queue", async () => {
    await sendEmail(props(textStep) as never)
    expect(renderStepDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ token: undefined }),
    )
    expect(lineRunAction.mock.calls[0]?.[1]).toMatchObject({
      ref: "email:t:test-token-xyz",
    })
    const mail = sent(0)
    expect(mail).toMatchObject({
      format: "text",
      html: undefined,
      text: "doc",
      subject: "Hello",
      threadKeys: [],
      replyTo: [],
    })
    expect(mail.messageKey).toMatch(MINTED_KEY)
    expect(recordOutgoing).toHaveBeenCalledWith(
      expect.objectContaining({
        messageKey: mail.messageKey,
        lineInboxId: "line-1",
        sequenceId: "555",
        flowId: "flow-1",
        subject: "Hello",
        parents: [],
      }),
    )
    expect(recordOutgoing.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      lineRunAction.mock.invocationCallOrder[0] ?? 0,
    )
    // Codex s226b: planned under the (contact, line) lock, inside its tx.
    expect(lineLocks).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      contactId: "contact-1",
      lineInboxId: "line-1",
    })
    expect(recordOutgoing.mock.calls[0]?.[0]).toMatchObject({
      tx: { tx: true },
    })
  })

  test("a plain flow run keys by its execution key, so its retry replays the same mail", async () => {
    const flowProps = () => ({
      ...props({ ...textStep, id: "step-3", threadMode: "latest" }, {}),
      flowExecutionKey: "job-77",
    })
    lineRunAction.mockRejectedValueOnce(new Error("outbox down"))
    await sendEmail(flowProps() as never)
    await sendEmail(flowProps() as never)
    expect(sent(1).messageKey).toBe(sent(0).messageKey)
    expect(sent(1).threadKeys).toEqual([])
  })

  test("a follow-up (default `previous`) replies under the sequence's newest mail: Re: its subject, its keys + its own key", async () => {
    mails.push(out({ messageKey: "bt.root-000001" }))
    mails.push(
      out({
        messageKey: "bt.two-0000001",
        parents: ["bt.root-000001"],
        subject: "Re: Saturday",
      }),
    )
    await sendEmail(props({ ...textStep, subject: "step 3 subject" }) as never)
    expect(sent(0)).toMatchObject({
      subject: "Re: Saturday",
      threadKeys: ["bt.root-000001", "bt.two-0000001"],
      replyTo: [],
    })
  })

  test("decision (b): the sequence's earlier mail went out on ANOTHER line, so this line starts a fresh thread (sent, not failed)", async () => {
    mails.push(out({ lineInboxId: "line-9" }))
    await sendEmail(props(textStep) as never)
    expect(sent(0)).toMatchObject({ subject: "Hello", threadKeys: [] })
    expect(markFailed).not.toHaveBeenCalled()
    expect(lineRunAction).toHaveBeenCalledOnce()
  })

  test("`latest` replies under the contact's OWN mail: its id + what it cited go as replyTo, In-Reply-To last", async () => {
    mails.push(out({}))
    mails.push({
      direction: "incoming",
      messageKey: null,
      messageId: "<CAK123@mail.gmail.com>",
      subject: "Re: Saturday",
      parents: ["<bt.root-000001@aftershockfam.org>"],
      lineInboxId: "line-1",
      sequenceId: "555",
    })
    await sendEmail(props({ ...textStep, threadMode: "latest" }, {}) as never)
    expect(sent(0)).toMatchObject({
      subject: "Re: Saturday",
      replyTo: [
        "<bt.root-000001@aftershockfam.org>",
        "<CAK123@mail.gmail.com>",
      ],
      threadKeys: [],
    })
  })

  test("`campaign` replies under the named broadcast's mail, not the sequence's newer one", async () => {
    mails.push(
      out({
        messageKey: "bt.bcast-000001",
        sequenceId: null,
        broadcastId: "42",
        subject: "News",
      }),
    )
    mails.push(out({ messageKey: "bt.seq-0000001" }))
    await sendEmail(
      props({
        ...textStep,
        threadMode: "campaign",
        threadCampaign: { broadcastId: "42" },
      }) as never,
    )
    expect(sent(0)).toMatchObject({
      subject: "Re: News",
      threadKeys: ["bt.bcast-000001"],
    })
  })

  test("`campaign` without a campaign is unusable content: counted, failed, nothing queued or recorded", async () => {
    await sendEmail(props({ ...textStep, threadMode: "campaign" }) as never)
    expect(markFailed).toHaveBeenCalledWith("test-token-xyz")
    expect(lineRunAction).not.toHaveBeenCalled()
    expect(recordOutgoing).not.toHaveBeenCalled()
  })

  test("`onNoThread: stop` with nothing in scope: no tracking row, no mail, no record, and the enrolment ends (no_email_thread)", async () => {
    await sendEmail(
      props({ ...textStep, threadMode: "latest", onNoThread: "stop" }) as never,
    )
    expect(createRecipient).not.toHaveBeenCalled()
    expect(buildLineEmailMock).not.toHaveBeenCalled()
    expect(recordOutgoing).not.toHaveBeenCalled()
    expect(removeEnrollment).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        contactId: "contact-1",
        sequenceIds: ["555"],
        reason: "no_email_thread",
      }),
    )
    // With a thread in scope, `stop` sends normally.
    mails.push(out({}))
    await sendEmail(
      props({ ...textStep, threadMode: "latest", onNoThread: "stop" }) as never,
    )
    expect(lineRunAction).toHaveBeenCalledOnce()
    expect(removeEnrollment).toHaveBeenCalledOnce()
  })

  test("a stored parent id that is not citable fails closed", async () => {
    mails.push(out({ messageKey: "x@evil.example" }))
    await sendEmail(props(textStep) as never)
    expect(buildLineEmailMock).not.toHaveBeenCalled()
    expect(markFailed).toHaveBeenCalled()
  })

  test("a line send that fails for good forgets its thread record, so no later step replies under it", async () => {
    lineRunAction.mockRejectedValueOnce(new Error("outbox down"))
    await sendEmail(props({ ...textStep, id: "step-1" }) as never)
    expect(forgetOutgoing).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      contactId: "contact-1",
      lineInboxId: "line-1",
      messageKey: sent(0).messageKey,
    })
    await sendEmail(props({ ...textStep, id: "step-2" }) as never)
    expect(sent(1)).toMatchObject({ subject: "Hello", threadKeys: [] })
  })

  test("a job that dies after planning keeps its record; its retry (same dispatch + step) replays the SAME key and headers, never a new parent", async () => {
    // A transient failure after the plan (the tracking row): the job retries.
    createRecipient.mockRejectedValueOnce(new Error("pg down"))
    await expect(
      sendEmail(props({ ...textStep, id: "step-9" }) as never),
    ).rejects.toThrow("pg down")
    expect(buildLineEmailMock).not.toHaveBeenCalled()
    const firstKey = (
      recordOutgoing.mock.calls[0]?.[0] as { messageKey: string }
    ).messageKey
    await sendEmail(props({ ...textStep, id: "step-9" }) as never)
    const first = sent(0)
    expect(first.messageKey).toBe(firstKey)
    buildLineEmailMock.mockClear()
    // A later mail landed in scope meanwhile: the replay must not reply to it.
    mails.push(out({ messageKey: "bt.later-000001" }))
    await sendEmail(props({ ...textStep, id: "step-9" }) as never)
    expect(sent(0)).toMatchObject({
      messageKey: first.messageKey,
      threadKeys: [],
      subject: "Hello",
    })
    // Another dispatch of the same step is a different mail.
    await sendEmail(
      props(
        { ...textStep, id: "step-9" },
        { ...seqMeta, dispatchId: "d2" },
      ) as never,
    )
    expect(sent(1).messageKey).not.toBe(first.messageKey)
  })

  test("outside a sequence a text mail is keyed and recorded (a future parent) but threads under nothing by default", async () => {
    for (const metadata of [
      {},
      null,
      { ...seqMeta, sequenceId: "" },
      { ...seqMeta, sequenceId: "1; drop" },
    ]) {
      mails.push(out({ sequenceId: null, flowId: "flow-1" }))
      buildLineEmailMock.mockClear()
      await sendEmail(props(textStep, metadata) as never)
      expect(sent(0)).toMatchObject({ format: "text", threadKeys: [] })
      expect(sent(0).messageKey).toMatch(MINTED_KEY)
    }
  })

  test("s229b: a new thread on a line with senders goes out from the picked sender, recorded and sent as `sender`", async () => {
    pickForNewThread.mockResolvedValueOnce("7001")
    await sendEmail(props({ ...textStep, id: "step-s1" }) as never)
    expect(sent(0).sender).toBe("7001")
    expect(recordOutgoing).toHaveBeenCalledWith(
      expect.objectContaining({ senderId: "7001", lineInboxId: "line-1" }),
    )
    expect(pickForNewThread.mock.calls[0]?.[0]).toEqual({ tx: true })
  })

  test("s229b: a retried job replays its recorded sender, never re-picks (a replay cannot switch mailbox)", async () => {
    createRecipient.mockRejectedValueOnce(new Error("pg down"))
    pickForNewThread.mockResolvedValueOnce("7001")
    await expect(
      sendEmail(props({ ...textStep, id: "step-r1" }) as never),
    ).rejects.toThrow("pg down")
    pickForNewThread.mockResolvedValueOnce("7009")
    await sendEmail(props({ ...textStep, id: "step-r1" }) as never)
    expect(sent(0).sender).toBe("7001")
    expect(pickForNewThread).toHaveBeenCalledTimes(1)
    expect(assertThreadSender).toHaveBeenCalledWith(
      { tx: true },
      { workspaceId: "ws-1", lineInboxId: "line-1", senderId: "7001" },
    )
  })

  test("s229b review: a replay whose recorded sender was archived meanwhile fails closed, never sends with it", async () => {
    const { EmailSenderUnavailableError } = await import(
      "@chatbotx.io/business/email-sender"
    )
    createRecipient.mockRejectedValueOnce(new Error("pg down"))
    pickForNewThread.mockResolvedValueOnce("7001")
    await expect(
      sendEmail(props({ ...textStep, id: "step-r2" }) as never),
    ).rejects.toThrow("pg down")
    assertThreadSender.mockRejectedValueOnce(
      new EmailSenderUnavailableError("sender-removed"),
    )
    await sendEmail(props({ ...textStep, id: "step-r2" }) as never)
    expect(buildLineEmailMock).not.toHaveBeenCalled()
    expect(lineRunAction).not.toHaveBeenCalled()
    expect(markFailed).toHaveBeenCalledTimes(1)
  })

  test("s229b: a follow-up keeps its parent's sender (never re-picks); a legacy parent stays on the env account", async () => {
    mails.push({
      ...out({ messageKey: "bt.root-000001" }),
      senderId: "7001",
    } as never)
    await sendEmail(props({ ...textStep, id: "step-s2" }) as never)
    expect(sent(0).sender).toBe("7001")
    expect(pickForNewThread).not.toHaveBeenCalled()
    expect(assertThreadSender).toHaveBeenCalledWith(
      { tx: true },
      { workspaceId: "ws-1", lineInboxId: "line-1", senderId: "7001" },
    )
    mails.length = 0
    buildLineEmailMock.mockClear()
    mails.push(out({ messageKey: "bt.root-000002" }))
    await sendEmail(props({ ...textStep, id: "step-s3" }) as never)
    expect(sent(0).sender).toBeNull()
    expect(pickForNewThread).not.toHaveBeenCalled()
  })

  test("s229b: an archived thread sender, or no active sender on the line, fails the send closed (nothing queued)", async () => {
    const { EmailSenderUnavailableError } = await import(
      "@chatbotx.io/business/email-sender"
    )
    mails.push({
      ...out({ messageKey: "bt.root-000003" }),
      senderId: "7002",
    } as never)
    assertThreadSender.mockRejectedValueOnce(
      new EmailSenderUnavailableError("sender-removed"),
    )
    await sendEmail(props({ ...textStep, id: "step-s4" }) as never)
    mails.length = 0
    pickForNewThread.mockRejectedValueOnce(
      new EmailSenderUnavailableError("no-active-sender"),
    )
    await sendEmail(props({ ...textStep, id: "step-s5" }) as never)
    expect(buildLineEmailMock).not.toHaveBeenCalled()
    expect(lineRunAction).not.toHaveBeenCalled()
    expect(recordOutgoing).not.toHaveBeenCalled()
    expect(markFailed).toHaveBeenCalledTimes(2)
  })

  test("an html step on a line is keyed too but tracked as before; a text step over SMTP is untouched", async () => {
    await sendEmail(props({ ...textStep, format: "html" }) as never)
    expect(renderStepDocumentMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ token: "test-token-xyz" }),
    )
    expect(sent(0)).toMatchObject({ format: "html", html: "<p>doc</p>" })
    expect(sent(0).messageKey).toMatch(MINTED_KEY)
    recordOutgoing.mockClear()
    const { lineInboxId: _l, ...smtpText } = textStep
    await sendEmail(props(smtpText) as never)
    expect(renderStepDocumentMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ token: "test-token-xyz" }),
    )
    expect(recordOutgoing).not.toHaveBeenCalled()
  })
})

describe("s236: a stop-on-reply sequence's line mail carries the line's reply gate", () => {
  const lineStep = { lineInboxId: "line-1", templateId: "77", elements: [] }
  const seqMeta = {
    type: "sequenceSchedule",
    sequenceId: "555",
    sequenceStepId: "1",
    dispatchId: "9001",
    contactInboxId: "ci-1",
  }
  const cycle = (over: Record<string, unknown> = {}) => ({
    stopOnReply: true,
    status: "active",
    enrolledAt: new Date("2026-10-01T12:00:20Z"),
    repliedAt: null,
    ...over,
  })
  const sendOptions = () =>
    lineRunAction.mock.calls.at(-1)?.[1] as Record<string, unknown>

  beforeEach(() => {
    lineRunAction.mockClear()
    runAction.mockClear()
    renderStepDocumentMock.mockResolvedValue({
      html: "<p>doc</p>",
      text: "doc",
      attachments: [],
    })
  })

  test("stopOnReply true, first cycle: skipIfRepliedSince = the minute after enrolment, read for THIS dispatch", async () => {
    findReplyGate.mockResolvedValue(cycle())
    await sendEmail({ ...makeProps(lineStep), metadata: seqMeta } as never)
    expect(findReplyGate).toHaveBeenCalledWith({
      dispatchId: "9001",
      workspaceId: "ws-1",
    })
    expect(lineRunAction).toHaveBeenCalledOnce()
    expect(sendOptions().skipIfRepliedSince).toBe("2026-10-01T12:01:00.000Z")
  })

  test("stopOnReply true, after a reply end + reactivation (repliedAt > enrolledAt): past the overridden reply", async () => {
    findReplyGate.mockResolvedValue(
      cycle({ repliedAt: new Date("2026-10-01T15:42:10.250Z") }),
    )
    await sendEmail({ ...makeProps(lineStep), metadata: seqMeta } as never)
    expect(sendOptions().skipIfRepliedSince).toBe("2026-10-01T15:43:00.000Z")
  })

  test("stopOnReply false: no option at all (the envelope stays as before)", async () => {
    findReplyGate.mockResolvedValue(cycle({ stopOnReply: false }))
    await sendEmail({ ...makeProps(lineStep), metadata: seqMeta } as never)
    expect(lineRunAction).toHaveBeenCalledOnce()
    expect(sendOptions()).not.toHaveProperty("skipIfRepliedSince")
  })

  test("a non-sequence line mail (flow run, broadcast): no option, no enrolment read", async () => {
    for (const metadata of [
      {},
      { type: "broadcast", broadcastId: "7", contactInboxId: "ci-1" },
    ]) {
      lineRunAction.mockClear()
      await sendEmail({ ...makeProps(lineStep), metadata } as never)
      expect(lineRunAction).toHaveBeenCalledOnce()
      expect(sendOptions()).not.toHaveProperty("skipIfRepliedSince")
    }
    expect(findReplyGate).not.toHaveBeenCalled()
  })

  test("a hub-SMTP sequence send is unchanged: no enrolment read, nothing new on the SMTP call", async () => {
    findReplyGate.mockResolvedValue(cycle())
    await sendEmail({ ...makeProps(), metadata: seqMeta } as never)
    expect(findReplyGate).not.toHaveBeenCalled()
    expect(lineRunAction).not.toHaveBeenCalled()
    expect(runAction).toHaveBeenCalledOnce()
    expect(runAction.mock.calls[0]?.[1]).not.toHaveProperty(
      "skipIfRepliedSince",
    )
  })

  test("a suppressed recipient is never read for or handed off", async () => {
    findReplyGate.mockResolvedValue(cycle())
    isSuppressedMock.mockResolvedValue(true)
    await sendEmail({ ...makeProps(lineStep), metadata: seqMeta } as never)
    expect(findReplyGate).not.toHaveBeenCalled()
    expect(lineRunAction).not.toHaveBeenCalled()
  })

  test("an enrolment read error fails the job BEFORE the tracking row (the retry starts clean)", async () => {
    findReplyGate.mockRejectedValue(new Error("db down"))
    createRecipient.mockClear()
    await expect(
      sendEmail({ ...makeProps(lineStep), metadata: seqMeta } as never),
    ).rejects.toThrow("db down")
    expect(createRecipient).not.toHaveBeenCalled()
    expect(lineRunAction).not.toHaveBeenCalled()
  })
})
