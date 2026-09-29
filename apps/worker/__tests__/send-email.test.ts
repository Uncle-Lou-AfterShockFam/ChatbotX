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
const { ContentError } = vi.hoisted(() => ({
  ContentError: class extends Error {},
}))
vi.mock("../src/integration/handlers/send-email-document", () => ({
  EmailContentError: ContentError,
  renderStepDocument: (...args: unknown[]) => renderStepDocumentMock(...args),
}))

const { sendEmail } = await import("../../src/integration/handlers/send-email")

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
  createRecipient.mockResolvedValue({ token: "test-token-xyz" })
  runAction.mockResolvedValue(undefined)
  renderDynamicEmailHtmlMock.mockReturnValue("<html/>")
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
