import { Readable } from "node:stream"
import { beforeEach, describe, expect, test, vi } from "vitest"

const { getDocument, findFile, resolveMapping, getObjectStream, NotFound } =
  vi.hoisted(() => {
    class NotFound extends Error {
      httpStatusCode = 404
    }
    return {
      getDocument: vi.fn(),
      findFile: vi.fn(),
      resolveMapping: vi.fn(),
      getObjectStream: vi.fn(),
      NotFound,
    }
  })

vi.mock("@chatbotx.io/business", () => ({
  mediaLibraryService: { findFile },
  signEmailClickUrl: vi.fn(async (url: string) => `signed(${url})`),
  signEmailFlowToken: vi.fn(
    async (p: Record<string, string>) =>
      `sealed.${p.workspaceId}.${p.flowId}.${p.nodeId ?? "-"}.${p.contactId}.${p.contactInboxId}`,
  ),
}))
vi.mock("@chatbotx.io/filesystem", () => ({
  uploader: { getObjectStream },
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

const {
  EmailContentError,
  MAX_ATTACHMENT_BYTES_TOTAL,
  MAX_ATTACHMENTS,
  prepareStepDocument,
  renderStepDocument,
} = await import("../src/integration/handlers/send-email-document")

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
  contact: { id: "c-9", contactInboxId: "ci-9" },
}

const render = async (step: object, token?: string) =>
  renderStepDocument({
    ...base,
    prepared: await prepareStepDocument({ ...base, step: step as never }),
    token,
  })

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

// ── s221b: attachment blocks become real attachments ─────────────────────────

const attachmentDoc = (...fileIds: string[]) => ({
  version: 1,
  settings: {},
  blocks: [
    { id: "1", type: "text", text: "<p>see attached</p>" },
    ...fileIds.map((fileId, i) => ({
      id: String(100 + i),
      type: "attachment",
      asset: { kind: "media", fileId },
    })),
  ],
})

const mediaFile = (id: string, extra: object = {}) => ({
  id,
  path: `public/space/ws-1/media/${id}`,
  url: `https://cdn.test/${id}`,
  name: `file-${id}.pdf`,
  size: 4,
  mimeType: "application/pdf",
  ...extra,
})

/** A stream that records whether it was torn down. */
function object(bytes: Buffer, contentLength?: number) {
  const stream = Readable.from([bytes])
  return { stream, contentLength }
}

describe("attachments (s221b)", () => {
  beforeEach(() => {
    findFile.mockImplementation(async ({ fileId }: { fileId: string }) =>
      mediaFile(fileId),
    )
    getObjectStream.mockImplementation(async (path: string) =>
      object(Buffer.from(`bytes:${path}`)),
    )
  })

  test("each distinct attachment is read by storage KEY, once, in document order", async () => {
    getDocument.mockResolvedValueOnce(attachmentDoc("8", "7", "8"))
    const out = await render({ templateId: "77" })
    expect(getObjectStream.mock.calls.map((c) => c[0])).toEqual([
      "public/space/ws-1/media/8",
      "public/space/ws-1/media/7",
    ])
    expect(out.attachments).toEqual([
      {
        filename: "file-8.pdf",
        content: Buffer.from("bytes:public/space/ws-1/media/8"),
        contentType: "application/pdf",
        key: "public/space/ws-1/media/8",
      },
      {
        filename: "file-7.pdf",
        content: Buffer.from("bytes:public/space/ws-1/media/7"),
        contentType: "application/pdf",
        key: "public/space/ws-1/media/7",
      },
    ])
  })

  test("a document without attachment blocks attaches nothing and reads no storage", async () => {
    const out = await render({ templateId: "77" })
    expect(out.attachments).toEqual([])
    expect(getObjectStream).not.toHaveBeenCalled()
  })

  test("an attachment missing from the library (404) fails closed", async () => {
    getDocument.mockResolvedValueOnce(attachmentDoc("8"))
    findFile.mockRejectedValueOnce(new NotFound("gone"))
    await expect(render({ templateId: "77" })).rejects.toBeInstanceOf(
      EmailContentError,
    )
  })

  test("a row whose object is gone (NoSuchKey) fails closed; any other storage error retries", async () => {
    getDocument.mockResolvedValue(attachmentDoc("8"))
    getObjectStream.mockRejectedValueOnce(
      Object.assign(new Error("gone"), { name: "NoSuchKey" }),
    )
    await expect(render({ templateId: "77" })).rejects.toBeInstanceOf(
      EmailContentError,
    )
    getObjectStream.mockRejectedValueOnce(new Error("ECONNRESET"))
    const error = await render({ templateId: "77" }).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(EmailContentError)
    expect(String(error)).toContain("ECONNRESET")
  })

  test(`more than ${MAX_ATTACHMENTS} distinct attachments fail closed before any lookup`, async () => {
    getDocument.mockResolvedValueOnce(
      attachmentDoc(
        ...Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => String(i + 1)),
      ),
    )
    await expect(render({ templateId: "77" })).rejects.toBeInstanceOf(
      EmailContentError,
    )
    expect(findFile).not.toHaveBeenCalled()
    expect(getObjectStream).not.toHaveBeenCalled()
  })

  test("the byte budget is enforced on the advertised length AND on the bytes read (the row size is never trusted)", async () => {
    getDocument.mockResolvedValue(attachmentDoc("8"))
    // Advertised too large: rejected before reading, stream torn down.
    const big = object(Buffer.from("x"), MAX_ATTACHMENT_BYTES_TOTAL + 1)
    getObjectStream.mockResolvedValueOnce(big)
    await expect(render({ templateId: "77" })).rejects.toBeInstanceOf(
      EmailContentError,
    )
    expect(big.stream.destroyed).toBe(true)
    // No advertised length, and the row claims 4 bytes: the read is capped.
    const liar = object(Buffer.alloc(MAX_ATTACHMENT_BYTES_TOTAL + 1))
    getObjectStream.mockResolvedValueOnce(liar)
    await expect(render({ templateId: "77" })).rejects.toBeInstanceOf(
      EmailContentError,
    )
  })

  test("the budget is TOTAL across attachments", async () => {
    getDocument.mockResolvedValueOnce(attachmentDoc("1", "2"))
    const half = MAX_ATTACHMENT_BYTES_TOTAL / 2 + 1
    getObjectStream.mockImplementation(async () =>
      object(Buffer.alloc(half), half),
    )
    await expect(render({ templateId: "77" })).rejects.toBeInstanceOf(
      EmailContentError,
    )
  })

  test("a client-supplied name and mime type cannot inject a path or a header", async () => {
    getDocument.mockResolvedValueOnce(attachmentDoc("8"))
    findFile.mockResolvedValueOnce(
      mediaFile("8", {
        name: "../../etc/pa\r\nX-Evil: 1\u0000sswd.pdf",
        mimeType: "text/html\r\nX-Evil: 1",
      }),
    )
    const [part] = (await render({ templateId: "77" })).attachments
    expect(part?.filename).toBe("paX-Evil: 1sswd.pdf")
    expect(part?.contentType).toBe("application/octet-stream")
  })

  test("tenancy probe: a row whose key climbs out of the workspace prefix fails closed and is never read", async () => {
    for (const path of [
      "workspaces/ws-1/../ws-2/documents/signed.pdf",
      "public/space/ws-2/media/8",
      "public/space/ws-1/media/%2e%2e/x",
    ]) {
      getDocument.mockResolvedValueOnce(attachmentDoc("8"))
      findFile.mockResolvedValueOnce(mediaFile("8", { path }))
      await expect(render({ templateId: "77" })).rejects.toBeInstanceOf(
        EmailContentError,
      )
    }
    expect(getObjectStream).not.toHaveBeenCalled()
  })

  test("stream probe: a hung read is aborted by the deadline and RETRIES (not fail closed); the stream is torn down", async () => {
    getDocument.mockResolvedValueOnce(attachmentDoc("8"))
    const controller = new AbortController()
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal)
    const hung = new Readable({
      read() {
        // never pushes: a read that hangs
      },
    })
    getObjectStream.mockResolvedValueOnce({ stream: hung })
    const pending = render({ templateId: "77" }).catch((e: unknown) => e)
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort(new Error("attachment read timed out"))
    const error = await pending
    timeout.mockRestore()
    expect(error).not.toBeInstanceOf(EmailContentError)
    expect(String(error)).toContain("timed out")
    expect(hung.destroyed).toBe(true)
    expect(getObjectStream).toHaveBeenCalledWith(expect.any(String), {
      abortSignal: controller.signal,
    })
  })

  test("a name past 200 chars is cut but keeps its extension", async () => {
    getDocument.mockResolvedValueOnce(attachmentDoc("8"))
    findFile.mockResolvedValueOnce(
      mediaFile("8", { name: `${"n".repeat(300)}.pdf` }),
    )
    const [part] = (await render({ templateId: "77" })).attachments
    expect(part?.filename).toHaveLength(200)
    expect(part?.filename.endsWith(".pdf")).toBe(true)
  })

  test("an empty stored name falls back to a stable name", async () => {
    getDocument.mockResolvedValueOnce(attachmentDoc("8"))
    findFile.mockResolvedValueOnce(mediaFile("8", { name: " / " }))
    const [part] = (await render({ templateId: "77" })).attachments
    expect(part?.filename).toBe("attachment-8")
  })

  test("attachments are exempt from the image cap; a missing image still only renders as missing", async () => {
    const images = Array.from({ length: 60 }, (_, i) => ({
      id: String(200 + i),
      type: "image",
      src: { kind: "media", fileId: String(1000 + i) },
      alt: "x",
    }))
    getDocument.mockResolvedValueOnce({
      ...attachmentDoc("8"),
      blocks: [...attachmentDoc("8").blocks, ...images],
    })
    const out = await render({ templateId: "77" })
    expect(out.attachments).toHaveLength(1)
    // 1 attachment + 50 images looked up; the other 10 images are not.
    expect(findFile).toHaveBeenCalledTimes(51)
  })

  test("property: any mix of attachment/image refs never attaches past the caps or an unresolved file", async () => {
    let seed = 7
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
      return seed % n
    }
    for (let run = 0; run < 40; run++) {
      vi.clearAllMocks()
      const known = new Set<string>()
      const blocks = Array.from({ length: 1 + rand(14) }, (_, i) => {
        const fileId = String(1 + rand(12))
        if (rand(3) > 0) {
          known.add(fileId)
        }
        return rand(2) === 0
          ? {
              id: String(i + 1),
              type: "attachment",
              asset: { kind: "media", fileId },
            }
          : {
              id: String(i + 1),
              type: "image",
              src: { kind: "media", fileId },
              alt: "x",
            }
      })
      getDocument.mockResolvedValueOnce({ version: 1, settings: {}, blocks })
      findFile.mockImplementation(({ fileId }: { fileId: string }) =>
        known.has(fileId)
          ? Promise.resolve(mediaFile(fileId))
          : Promise.reject(new NotFound("gone")),
      )
      getObjectStream.mockImplementation(async (path: string) =>
        object(Buffer.from(path)),
      )
      const out = await render({ templateId: "77" }).catch((e: unknown) => e)
      const attached = new Set(
        blocks.flatMap((b) =>
          b.type === "attachment" && "asset" in b ? [b.asset.fileId] : [],
        ),
      )
      if (out instanceof Error) {
        expect(out).toBeInstanceOf(EmailContentError)
        expect(
          attached.size > MAX_ATTACHMENTS ||
            [...attached].some((id) => !known.has(id)),
        ).toBe(true)
      } else {
        const result = out as { attachments: { filename: string }[] }
        expect(result.attachments.length).toBe(attached.size)
        expect(result.attachments.length).toBeLessThanOrEqual(MAX_ATTACHMENTS)
        for (const part of result.attachments) {
          const id = part.filename.replace("file-", "").replace(".pdf", "")
          expect(known.has(id)).toBe(true)
        }
      }
    }
  })
})

// ── s222b: a start-flow button on an email-only inbox ────────────────────────

describe("start-flow buttons with no chat to open (s222b)", () => {
  const flowButton = (id: string, beforeStep: object) => ({
    id,
    type: "button",
    label: `Go${id}`,
    action: { kind: "flow", beforeStep, steps: [] },
  })

  test("startExternalFlow / startExternalNode get the sealed /email-topic/flow link for this contact, carrying the recipient token; never click-wrapped", async () => {
    getDocument.mockResolvedValueOnce({
      version: 1,
      settings: {},
      blocks: [
        flowButton("1", {
          id: "11",
          stepType: "startExternalFlow",
          flowId: "700",
        }),
        flowButton("2", {
          id: "12",
          stepType: "startExternalNode",
          flowId: "701",
          nodeId: "703",
        }),
      ],
    })
    const out = await render({ templateId: "77" }, "tok-1")
    const hrefs = [...out.html.matchAll(/href="([^"]+)"/g)].map((m) =>
      m[1].replaceAll("&amp;", "&"),
    )
    expect(hrefs).toContain(
      "https://hub.test/email-topic/flow?t=sealed.ws-1.700.-.c-9.ci-9&r=tok-1",
    )
    expect(hrefs).toContain(
      "https://hub.test/email-topic/flow?t=sealed.ws-1.701.703.c-9.ci-9&r=tok-1",
    )
    expect(out.html).not.toContain("email-topic/click")
  })

  test("without a topic token the link has no r; a node-local button with no chat link is still dropped", async () => {
    getDocument.mockResolvedValueOnce({
      version: 1,
      settings: {},
      blocks: [
        flowButton("1", {
          id: "11",
          stepType: "startExternalFlow",
          flowId: "700",
        }),
        flowButton("2", {
          id: "12",
          stepType: "startAnotherNode",
          nodeId: "n-1",
        }),
      ],
    })
    const out = await render({ templateId: "77" })
    expect(out.html).toContain(
      "https://hub.test/email-topic/flow?t=sealed.ws-1.700.-.c-9.ci-9",
    )
    expect(out.html).not.toContain("&amp;r=")
    expect(out.html).not.toContain("Go2")
  })
})
