import { beforeEach, describe, expect, test, vi } from "vitest"

const { getDocument, findFile, resolveMapping, NotFound } = vi.hoisted(() => {
  class NotFound extends Error {
    httpStatusCode = 404
  }
  return {
    getDocument: vi.fn(),
    findFile: vi.fn(),
    resolveMapping: vi.fn(),
    NotFound,
  }
})

vi.mock("@chatbotx.io/business", () => ({
  mediaLibraryService: { findFile },
  signEmailClickUrl: vi.fn(async (url: string) => `signed(${url})`),
}))
vi.mock("@chatbotx.io/business/errors", () => ({ ChatbotXException: NotFound }))
vi.mock("@chatbotx.io/business/email-templates", () => ({
  emailTemplateService: { getDocument },
}))
vi.mock("@chatbotx.io/variables", () => ({
  contactVariableService: { resolveMapping },
}))
vi.mock("../src/lib/convert-button", () => ({
  resolveButtonUrl: vi.fn(
    ({ button }: { button: { beforeStep: { url?: string } } }) =>
      button.beforeStep.url,
  ),
}))
vi.mock("../src/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { EmailContentError, renderStepDocument } = await import(
  "../src/integration/handlers/send-email-document"
)

const DROPPED_LABELS = />\s*(NoFlowId|Mystery|Proto)\s*</
const KEPT_LABEL = />\s*Ok\s*</

const OPEN_WEBSITE = {
  id: "101",
  stepType: "openWebsite",
  url: "https://site.test",
  browserSize: 100,
}

const DOC = {
  version: 1,
  settings: { preheader: "Hi {{first_name}}" },
  blocks: [
    {
      id: "1",
      type: "text",
      text: '<p>Hello {{first_name}} <a href="https://x.test/a">read</a> <a href="<<unsubscribeUrl>>">stop</a></p>',
    },
    {
      id: "2",
      type: "button",
      label: "Visit",
      action: { kind: "flow", beforeStep: OPEN_WEBSITE, steps: [] },
    },
    {
      id: "3",
      type: "image",
      src: { kind: "media", fileId: "9" },
      alt: "logo",
    },
  ],
}

const base = {
  workspaceId: "ws-1",
  appUrl: "https://hub.test",
  variables: {} as never,
  inbox: undefined,
  flowId: "f-1",
  unsubscribeUrl: "https://hub.test/unsubscribe?token=u",
}

const render = (step: object, token?: string) =>
  renderStepDocument({ ...base, step: step as never, token })

beforeEach(() => {
  vi.clearAllMocks()
  getDocument.mockResolvedValue(DOC)
  resolveMapping.mockResolvedValue({ first_name: "Ada" })
  findFile.mockResolvedValue({
    url: "https://cdn.test/logo.png",
    name: "logo.png",
    size: 10,
    mimeType: "image/png",
  })
})

describe("renderStepDocument (B2 phase 2b)", () => {
  test("a saved template renders with vars, tracked links, button, asset, pixel and unsubscribe", async () => {
    const out = await render({ templateId: "77" }, "tok")
    expect(getDocument).toHaveBeenCalledWith({ workspaceId: "ws-1", id: "77" })
    expect(resolveMapping).toHaveBeenCalledWith(
      expect.objectContaining({ text: "{{first_name}}" }),
    )
    expect(out.html).toContain("Hello Ada")
    expect(out.html).toContain(
      "https://hub.test/email-topic/click?r=tok&amp;u=signed(https://x.test/a)",
    )
    expect(out.html).toContain(
      "https://hub.test/email-topic/click?r=tok&amp;u=signed(https://site.test)",
    )
    expect(out.html).toContain("https://cdn.test/logo.png")
    expect(out.html).toContain("https://hub.test/email-topic/open?r=tok")
    expect(out.html).toContain("https://hub.test/unsubscribe?token=u")
    expect(out.text).toContain("Hello Ada")
  })

  test("without a topic nothing is tracked and there is no pixel", async () => {
    const out = await render({ document: DOC })
    expect(getDocument).not.toHaveBeenCalled()
    expect(out.html).toContain('href="https://x.test/a"')
    expect(out.html).not.toContain("email-topic")
  })

  test("a document with no tokens never calls the variable resolvers", async () => {
    getDocument.mockResolvedValueOnce({
      version: 1,
      settings: {},
      blocks: [{ id: "1", type: "divider" }],
    })
    await render({ templateId: "77" })
    expect(resolveMapping).not.toHaveBeenCalled()
  })
})

describe("fail closed on content, retry on everything else (skeptic HIGH)", () => {
  test("an invalid inline document is an EmailContentError", async () => {
    await expect(
      render({
        document: {
          version: 1,
          settings: {},
          blocks: [{ id: "1", type: "script" }],
        },
      }),
    ).rejects.toBeInstanceOf(EmailContentError)
  })

  test("a missing template (404) is an EmailContentError", async () => {
    getDocument.mockRejectedValueOnce(new NotFound("Email template not found"))
    await expect(render({ templateId: "404" })).rejects.toBeInstanceOf(
      EmailContentError,
    )
  })

  test("a transient template read error propagates unchanged (queue retry)", async () => {
    getDocument.mockRejectedValueOnce(new Error("connection reset"))
    const error = await render({ templateId: "77" }).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(EmailContentError)
    expect(String(error)).toContain("connection reset")
  })

  test("a deleted media file is skipped; a storage failure propagates", async () => {
    findFile.mockRejectedValueOnce(new NotFound("gone"))
    expect((await render({ templateId: "77" })).html).not.toContain("cdn.test")
    findFile.mockRejectedValueOnce(new Error("S3 timeout"))
    await expect(render({ templateId: "77" })).rejects.toThrow("S3 timeout")
  })
})

describe("flow buttons validated by flow-config (skeptic MEDIUM)", () => {
  test("a beforeStep failing its step schema, an unknown or a prototype stepType is dropped", async () => {
    getDocument.mockResolvedValueOnce({
      version: 1,
      settings: {},
      blocks: [
        {
          id: "1",
          type: "button",
          label: "NoFlowId",
          action: {
            kind: "flow",
            beforeStep: { id: "5", stepType: "startExternalFlow" },
            steps: [],
          },
        },
        {
          id: "2",
          type: "button",
          label: "Mystery",
          action: {
            kind: "flow",
            beforeStep: { stepType: "mystery" },
            steps: [],
          },
        },
        {
          id: "3",
          type: "button",
          label: "Proto",
          action: {
            kind: "flow",
            beforeStep: { stepType: "__proto__" },
            steps: [],
          },
        },
        {
          id: "4",
          type: "button",
          label: "Ok",
          action: { kind: "flow", beforeStep: OPEN_WEBSITE, steps: [] },
        },
      ],
    })
    const out = await render({ templateId: "77" })
    expect(out.html).not.toMatch(DROPPED_LABELS)
    expect(out.html).toMatch(KEPT_LABEL)
  })
})
