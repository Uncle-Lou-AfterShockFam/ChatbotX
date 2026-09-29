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

// s225b: the sequence thread store (its SQL is covered by the business real-DB suite).
const threadFind = vi.fn()
const threadRecord = vi.fn()
const threadClaim = vi.fn()
const threadRelease = vi.fn()
vi.mock("@chatbotx.io/business/email-thread", () => ({
  emailThreadService: {
    find: (...args: unknown[]) => threadFind(...args),
    recordSent: (...args: unknown[]) => threadRecord(...args),
    claimRoot: (...args: unknown[]) => threadClaim(...args),
    releaseRoot: (...args: unknown[]) => threadRelease(...args),
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
        broadcastId: "b-1",
        contactInboxId: "ci-1",
      },
    } as never)
    expect(prepareStepDocumentMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ broadcastId: "b-1" }),
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
    const replaceAll = vi.mocked(contactVariableService.replaceAll)
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
      replaceAll.mockClear()
      await sendEmail(
        makeProps({
          to: "jane@example.com",
          lineInboxId: "line-1",
          templateId: "77",
        }) as never,
      )
      const subjectCall = replaceAll.mock.calls.find(
        ([arg]) => (arg as { text: string }).text === "Hello",
      )?.[0] as { variables: { personalLinks?: boolean } }
      expect(subjectCall.variables.personalLinks).toBe(expected)
    }
  })

  test("the body is resolved with the opt-in only when the recipient is the contact", async () => {
    const { contactVariableService } = await import("@chatbotx.io/variables")
    const getAll = vi.mocked(contactVariableService.getAll)
    const replaceAll = vi.mocked(contactVariableService.replaceAll)
    for (const [to, expected] of [
      ["jane@example.com", true],
      ["boss@example.com", false],
    ] as const) {
      getAll.mockResolvedValueOnce({
        contact: { email: "jane@example.com" },
      } as never)
      replaceAll.mockClear()
      await sendEmail(makeProps({ to }) as never)
      const subjectCall = replaceAll.mock.calls.find(
        ([arg]) => (arg as { text: string }).text === "Hello",
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

describe("s225b outreach B-1: a text step on a line is text/plain, untracked, and threads inside a sequence", () => {
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
  const ref = { workspaceId: "ws-1", contactId: "contact-1", sequenceId: "555" }

  beforeEach(() => {
    for (const m of [threadFind, threadRecord, threadClaim, threadRelease]) {
      m.mockReset()
    }
    threadFind.mockResolvedValue(null)
    threadRecord.mockResolvedValue({ id: "t-1" })
    threadClaim.mockResolvedValue({ id: "t-1" })
    threadRelease.mockResolvedValue(undefined)
    buildLineEmailMock.mockClear()
    lineRunAction.mockClear()
    markFailed.mockClear()
    renderStepDocumentMock.mockReset()
    renderStepDocumentMock.mockResolvedValue({
      html: "<p>doc</p>",
      text: "doc",
      attachments: [],
    })
  })

  test("the first step: rendered WITHOUT a token (no pixel, no signed links), no html to the line, a fresh key that CLAIMS the root before the queue", async () => {
    await sendEmail(props(textStep) as never)
    expect(renderStepDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ token: undefined }),
    )
    // The tracking row still exists: the line's status settles it.
    expect(lineRunAction.mock.calls[0]?.[1]).toMatchObject({
      ref: "email:t:test-token-xyz",
    })
    const mail = buildLineEmailMock.mock.calls[0]?.[0]
    expect(mail).toMatchObject({
      format: "text",
      html: undefined,
      text: "doc",
      subject: "Hello",
      threadKeys: [],
    })
    expect(mail.messageKey).toMatch(MINTED_KEY)
    expect(threadClaim).toHaveBeenCalledWith({
      ...ref,
      lineInboxId: "line-1",
      subject: "Hello",
      key: mail.messageKey,
    })
    expect(threadClaim.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      lineRunAction.mock.invocationCallOrder[0] ?? 0,
    )
    // The root is already stored: neither recorded again nor released.
    expect(threadRecord).not.toHaveBeenCalled()
    expect(threadRelease).not.toHaveBeenCalled()
  })

  test("a follow-up replies under the thread (Re: <first subject>, References = stored keys) and is recorded after the queue", async () => {
    threadFind.mockResolvedValue({
      id: "t-1",
      lineInboxId: "line-1",
      subject: "Saturday",
      keys: ["bt.root-000001", "bt.two-0000001"],
    })
    await sendEmail(props({ ...textStep, subject: "step 2 subject" }) as never)
    const mail = buildLineEmailMock.mock.calls[0]?.[0]
    expect(mail).toMatchObject({
      subject: "Re: Saturday",
      threadKeys: ["bt.root-000001", "bt.two-0000001"],
      format: "text",
    })
    expect(mail.messageKey).not.toBe("bt.root-000001")
    expect(threadClaim).not.toHaveBeenCalled()
    expect(threadRecord).toHaveBeenCalledWith({
      ...ref,
      lineInboxId: "line-1",
      subject: "step 2 subject",
      key: mail.messageKey,
    })
  })

  test("losing the root race (claim returns null) follows up under the winner instead of starting a second thread", async () => {
    threadFind.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "t-1",
      lineInboxId: "line-1",
      subject: "Winner",
      keys: ["bt.winner-00001"],
    })
    threadClaim.mockResolvedValueOnce(null)
    await sendEmail(props(textStep) as never)
    expect(buildLineEmailMock.mock.calls[0]?.[0]).toMatchObject({
      subject: "Re: Winner",
      threadKeys: ["bt.winner-00001"],
    })
    expect(threadRecord).toHaveBeenCalledOnce()
  })

  test("a thread on ANOTHER line (found, or won by a racing send) fails closed: counted, failed, nothing queued or recorded", async () => {
    threadFind.mockResolvedValue({
      id: "t-1",
      lineInboxId: "line-9",
      subject: "s",
      keys: ["bt.root-000001"],
    })
    await sendEmail(props(textStep) as never)
    threadFind.mockReset()
    threadFind.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "t-1",
      lineInboxId: "line-9",
      subject: "s",
      keys: ["bt.winner-00001"],
    })
    threadClaim.mockResolvedValueOnce(null)
    await sendEmail(props(textStep) as never)
    expect(markFailed).toHaveBeenCalledTimes(2)
    expect(buildLineEmailMock).not.toHaveBeenCalled()
    expect(lineRunAction).not.toHaveBeenCalled()
    expect(threadRecord).not.toHaveBeenCalled()
  })

  test("a stored key that is not a hub key fails closed too", async () => {
    threadFind.mockResolvedValue({
      id: "t-1",
      lineInboxId: "line-1",
      subject: "s",
      keys: ["x@evil.example"],
    })
    await sendEmail(props(textStep) as never)
    expect(buildLineEmailMock).not.toHaveBeenCalled()
    expect(markFailed).toHaveBeenCalled()
  })

  test("a claimed root whose mail is never queued is released: failed hand-off, content error, transient throw", async () => {
    lineRunAction.mockRejectedValueOnce(new Error("outbox down"))
    await sendEmail(props(textStep) as never)
    expect(threadRelease).toHaveBeenCalledTimes(1)
    buildLineEmailMock.mockRejectedValueOnce(new ContentError("too large"))
    await sendEmail(props(textStep) as never)
    expect(threadRelease).toHaveBeenCalledTimes(2)
    renderStepDocumentMock.mockRejectedValueOnce(new Error("ECONNRESET"))
    await expect(sendEmail(props(textStep) as never)).rejects.toThrow(
      "ECONNRESET",
    )
    expect(threadRelease).toHaveBeenCalledTimes(3)
    expect(threadRelease.mock.calls[0]?.[0]).toEqual({
      ...ref,
      key: expect.stringMatching(MINTED_KEY),
    })
    // A failed release never masks the send's outcome.
    threadRelease.mockRejectedValueOnce(new Error("pg down"))
    lineRunAction.mockRejectedValueOnce(new Error("outbox down"))
    await expect(sendEmail(props(textStep) as never)).resolves.toBeUndefined()
  })

  test("a follow-up whose queue fails records nothing; a failed thread write never fails a queued send", async () => {
    threadFind.mockResolvedValue({
      id: "t-1",
      lineInboxId: "line-1",
      subject: "s",
      keys: ["bt.root-000001"],
    })
    lineRunAction.mockRejectedValueOnce(new Error("outbox down"))
    await sendEmail(props(textStep) as never)
    expect(threadRecord).not.toHaveBeenCalled()
    expect(threadRelease).not.toHaveBeenCalled()
    markFailed.mockClear()
    threadRecord.mockRejectedValueOnce(new Error("pg down"))
    await expect(sendEmail(props(textStep) as never)).resolves.toBeUndefined()
    expect(markFailed).not.toHaveBeenCalled()
  })

  test("a retried job (same dispatch + step) reuses its key: the replay gets its first headers and never releases the root", async () => {
    await sendEmail(props({ ...textStep, id: "step-9" }) as never)
    const first = buildLineEmailMock.mock.calls[0]?.[0]
    // Same job again, now that its root is stored: same key, root headers.
    threadFind.mockResolvedValue({
      id: "t-1",
      lineInboxId: "line-1",
      subject: "Hello",
      keys: [first.messageKey, "bt.later-000001"],
    })
    lineRunAction.mockRejectedValueOnce(new Error("outbox down"))
    await sendEmail(props({ ...textStep, id: "step-9" }) as never)
    const replay = buildLineEmailMock.mock.calls[1]?.[0]
    expect(replay).toMatchObject({
      messageKey: first.messageKey,
      threadKeys: [],
      subject: "Hello",
    })
    expect(threadRelease).not.toHaveBeenCalled()
    // Another dispatch of the same step is a different mail.
    await sendEmail(
      props(
        { ...textStep, id: "step-9" },
        { ...seqMeta, dispatchId: "d2" },
      ) as never,
    )
    expect(buildLineEmailMock.mock.calls[2]?.[0].messageKey).not.toBe(
      first.messageKey,
    )
  })

  test("outside a sequence (or with a junk sequence id) a text mail is not threaded", async () => {
    for (const metadata of [
      {},
      null,
      { type: "broadcast", sequenceId: "555" },
      { ...seqMeta, sequenceId: "" },
      { ...seqMeta, sequenceId: "1; drop" },
      { ...seqMeta, sequenceId: 5 },
    ]) {
      buildLineEmailMock.mockClear()
      await sendEmail(props(textStep, metadata) as never)
      expect(buildLineEmailMock.mock.calls[0]?.[0]).toMatchObject({
        format: "text",
        messageKey: undefined,
        threadKeys: undefined,
      })
    }
    expect(threadFind).not.toHaveBeenCalled()
    expect(threadClaim).not.toHaveBeenCalled()
    expect(threadRecord).not.toHaveBeenCalled()
  })

  test("an html step in a sequence, or a text step over SMTP, is unchanged (tracked, no thread)", async () => {
    await sendEmail(props({ ...textStep, format: "html" }) as never)
    expect(renderStepDocumentMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ token: "test-token-xyz" }),
    )
    expect(buildLineEmailMock.mock.calls[0]?.[0]).toMatchObject({
      format: "html",
      html: "<p>doc</p>",
    })
    const { lineInboxId: _l, ...smtpText } = textStep
    await sendEmail(props(smtpText) as never)
    expect(renderStepDocumentMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ token: "test-token-xyz" }),
    )
    expect(threadFind).not.toHaveBeenCalled()
  })
})
