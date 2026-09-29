import { beforeEach, describe, expect, test, vi } from "vitest"

const { getDocument, findFile, resolveMapping } = vi.hoisted(() => ({
  getDocument: vi.fn(),
  findFile: vi.fn(),
  resolveMapping: vi.fn(),
}))

vi.mock("@chatbotx.io/business", () => ({
  mediaLibraryService: { findFile },
  signEmailClickUrl: vi.fn(async (url: string) => `signed(${url})`),
}))
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

const { renderStepDocument } = await import(
  "../src/integration/handlers/send-email-document"
)

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
      action: {
        kind: "flow",
        beforeStep: { stepType: "openWebsite", url: "https://site.test" },
        steps: [],
      },
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
    const out = await renderStepDocument({
      ...base,
      step: { templateId: "77" } as never,
      token: "tok",
    })
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
    const out = await renderStepDocument({
      ...base,
      step: { document: DOC } as never,
      token: undefined,
    })
    expect(getDocument).not.toHaveBeenCalled()
    expect(out.html).toContain('href="https://x.test/a"')
    expect(out.html).not.toContain("email-topic")
  })

  test("an invalid inline document throws (the caller fails the send closed)", async () => {
    await expect(
      renderStepDocument({
        ...base,
        step: {
          document: {
            version: 1,
            settings: {},
            blocks: [{ id: "1", type: "script" }],
          },
        } as never,
        token: undefined,
      }),
    ).rejects.toThrow()
  })

  test("a missing template propagates the not-found error", async () => {
    getDocument.mockRejectedValueOnce(new Error("Email template not found"))
    await expect(
      renderStepDocument({
        ...base,
        step: { templateId: "404" } as never,
        token: undefined,
      }),
    ).rejects.toThrow("Email template not found")
  })

  test("an unknown media file or button type renders without them (no crash)", async () => {
    findFile.mockRejectedValueOnce(new Error("not found"))
    getDocument.mockResolvedValueOnce({
      ...DOC,
      blocks: [
        ...DOC.blocks,
        {
          id: "4",
          type: "button",
          label: "Odd",
          action: {
            kind: "flow",
            beforeStep: { stepType: "mystery" },
            steps: [],
          },
        },
      ],
    })
    const out = await renderStepDocument({
      ...base,
      step: { templateId: "77" } as never,
      token: undefined,
    })
    expect(out.html).not.toContain("cdn.test")
    expect(out.html).not.toContain(">Odd<")
  })

  test("a document with no tokens never calls the variable resolvers", async () => {
    getDocument.mockResolvedValueOnce({
      version: 1,
      settings: {},
      blocks: [{ id: "1", type: "divider" }],
    })
    await renderStepDocument({
      ...base,
      step: { templateId: "77" } as never,
      token: undefined,
    })
    expect(resolveMapping).not.toHaveBeenCalled()
  })
})
