// @vitest-environment node
import { createHash } from "node:crypto"
import { beforeEach, describe, expect, test, vi } from "vitest"

const inboxFind = vi.fn()
const contactInboxFind = vi.fn()
vi.mock("@chatbotx.io/business", () => ({
  inboxService: { find: (...args: unknown[]) => inboxFind(...args) },
  contactInboxService: {
    findByUncached: (...args: unknown[]) => contactInboxFind(...args),
  },
}))
const getPresignedDownload = vi.fn()
vi.mock("@chatbotx.io/filesystem", () => ({
  uploader: {
    getPresignedDownload: (...args: unknown[]) => getPresignedDownload(...args),
  },
}))
const { ContentError } = vi.hoisted(() => ({
  ContentError: class extends Error {},
}))
vi.mock("../src/integration/handlers/send-email-document", () => ({
  EmailContentError: ContentError,
}))

const {
  buildLineEmail,
  LINE_ATTACHMENT_URL_TTL_SECONDS,
  LINE_EMAIL_LIMITS,
  resolveEmailLine,
} = await import("../src/integration/handlers/send-email-line")

const args = { workspaceId: "ws-1", contactId: "c-1", lineInboxId: "line-1" }

describe("resolveEmailLine (s222b): the line and the contact's address on it, or unusable content", () => {
  beforeEach(() => {
    inboxFind.mockResolvedValue({ id: "line-1", channel: "api" })
    contactInboxFind.mockResolvedValue({
      id: "ci-1",
      inboxId: "line-1",
      sourceId: "jane@example.com",
    })
  })

  test("an API inbox of this workspace with the contact on it resolves to that ContactInbox", async () => {
    await expect(resolveEmailLine(args)).resolves.toMatchObject({
      id: "ci-1",
      sourceId: "jane@example.com",
    })
    expect(inboxFind).toHaveBeenCalledWith({
      where: { id: "line-1", workspaceId: "ws-1" },
    })
    expect(contactInboxFind).toHaveBeenCalledWith({
      where: { contactId: "c-1", inboxId: "line-1", channel: "api" },
    })
  })

  test("another workspace's inbox (not found in this one) is refused", async () => {
    inboxFind.mockResolvedValueOnce(undefined)
    await expect(resolveEmailLine(args)).rejects.toBeInstanceOf(ContentError)
    expect(contactInboxFind).not.toHaveBeenCalled()
  })

  test("a non-API inbox (e.g. SMTP, messenger) is refused", async () => {
    inboxFind.mockResolvedValueOnce({ id: "line-1", channel: "messenger" })
    await expect(resolveEmailLine(args)).rejects.toThrow("not an email line")
  })

  test("a contact with no identity on the line, or a phone identity, is refused", async () => {
    contactInboxFind.mockResolvedValueOnce(undefined)
    await expect(resolveEmailLine(args)).rejects.toBeInstanceOf(ContentError)
    contactInboxFind.mockResolvedValueOnce({
      id: "ci-2",
      sourceId: "+15550000001",
    })
    await expect(resolveEmailLine(args)).rejects.toThrow("no email address")
    contactInboxFind.mockResolvedValueOnce({ id: "ci-3", sourceId: null })
    await expect(resolveEmailLine(args)).rejects.toBeInstanceOf(ContentError)
  })

  test("a storage/DB error is NOT content: it propagates for the retry", async () => {
    inboxFind.mockRejectedValueOnce(new Error("ECONNRESET"))
    await expect(resolveEmailLine(args)).rejects.toThrow("ECONNRESET")
  })
})

describe("buildLineEmail (s222b): the line's caps enforced before enqueue", () => {
  const mail = (over: Record<string, unknown> = {}) => ({
    appUrl: "https://app.test/",
    subject: "Hello",
    html: "<p>Hi</p>",
    text: "Hi",
    headers: { "List-Unsubscribe": "<https://app.test/u>" },
    attachments: [],
    ...over,
  })

  beforeEach(() => {
    getPresignedDownload.mockImplementation(
      async (key: string) =>
        `https://app.test/storage/${key}?X-Amz-Signature=s`,
    )
  })

  test("s229b: `sender` travels only when set (an old line refuses the unknown key) and only as a bigint id", async () => {
    for (const sender of [undefined, null]) {
      const out = await buildLineEmail(mail({ sender }) as never)
      expect("sender" in out).toBe(false)
    }
    await expect(
      buildLineEmail(mail({ sender: "117" }) as never),
    ).resolves.toMatchObject({ sender: "117" })
    for (const bad of ["", "abc", "1".repeat(20), "1 2", "-1"]) {
      await expect(
        buildLineEmail(mail({ sender: bad }) as never),
      ).rejects.toBeInstanceOf(ContentError)
    }
  })

  test("attachments become signed public downloads (24 h) with their MEASURED size", async () => {
    const out = await buildLineEmail(
      mail({
        attachments: [
          {
            filename: "a.pdf",
            content: Buffer.from("%PDF-1.4"),
            contentType: "application/pdf",
            key: "public/space/ws-1/media/a.pdf",
          },
        ],
      }) as never,
    )
    expect(getPresignedDownload).toHaveBeenCalledWith(
      "public/space/ws-1/media/a.pdf",
      LINE_ATTACHMENT_URL_TTL_SECONDS,
    )
    expect(LINE_ATTACHMENT_URL_TTL_SECONDS).toBe(86_400)
    expect(out).toEqual({
      subject: "Hello",
      html: "<p>Hi</p>",
      text: "Hi",
      headers: { "List-Unsubscribe": "<https://app.test/u>" },
      attachments: [
        {
          url: "https://app.test/storage/public/space/ws-1/media/a.pdf?X-Amz-Signature=s",
          name: "a.pdf",
          mimeType: "application/pdf",
          size: 8,
          sha256: createHash("sha256").update("%PDF-1.4").digest("hex"),
        },
      ],
    })
  })

  test("a storage base on another origin than the hub fails here with the reason (the line only downloads from the hub)", async () => {
    getPresignedDownload.mockResolvedValueOnce(
      "https://cdn.other.test/public/a.pdf?X-Amz-Signature=s",
    )
    await expect(
      buildLineEmail(
        mail({
          attachments: [
            {
              filename: "a.pdf",
              content: Buffer.from("x"),
              contentType: "application/pdf",
              key: "public/a.pdf",
            },
          ],
        }) as never,
      ),
    ).rejects.toThrow("S3_PUBLIC_UPLOAD_URL")
  })

  test("a merged subject's line breaks collapse to spaces (the line refuses control characters)", async () => {
    const out = await buildLineEmail(
      mail({ subject: " Hi\r\nthere\t! " }) as never,
    )
    expect(out.subject).toBe("Hi there !")
  })

  test("an empty or over-long subject, or html/text past the byte caps, is unusable content", async () => {
    for (const over of [
      { subject: " \r\n " },
      { subject: "s".repeat(LINE_EMAIL_LIMITS.subject + 1) },
      // 3-byte characters: under the cap in chars, over it in bytes.
      { html: "€".repeat(Math.floor(LINE_EMAIL_LIMITS.htmlBytes / 3) + 1) },
      { text: "t".repeat(LINE_EMAIL_LIMITS.textBytes + 1) },
    ]) {
      await expect(buildLineEmail(mail(over) as never)).rejects.toBeInstanceOf(
        ContentError,
      )
    }
    expect(getPresignedDownload).not.toHaveBeenCalled()
  })
})

describe("buildLineEmail (s225b): text format and hub thread keys", () => {
  const base = {
    appUrl: "https://app.test/",
    subject: "Hello",
    text: "Hi",
    headers: {},
    attachments: [],
  }

  test("an html mail keeps its old shape exactly (no format / key fields)", async () => {
    const r = await buildLineEmail({ ...base, html: "<p>Hi</p>" })
    expect(Object.keys(r).sort()).toEqual([
      "attachments",
      "headers",
      "html",
      "subject",
      "text",
    ])
    expect(r).toEqual({
      subject: "Hello",
      html: "<p>Hi</p>",
      text: "Hi",
      headers: {},
      attachments: [],
    })
  })

  test("a text mail has no html key at all, and carries its keys", async () => {
    const r = await buildLineEmail({
      ...base,
      html: "<p>ignored</p>",
      format: "text",
      messageKey: "bt.key-000002",
      threadKeys: ["bt.key-000001"],
    })
    expect(r).toEqual({
      format: "text",
      subject: "Hello",
      text: "Hi",
      headers: {},
      messageKey: "bt.key-000002",
      threadKeys: ["bt.key-000001"],
      attachments: [],
    })
    expect("html" in r).toBe(false)
  })

  test("unusable: text without a body, html without html, keys without a messageKey, more than 20 ancestors", async () => {
    await expect(
      buildLineEmail({ ...base, format: "text", text: "  " }),
    ).rejects.toBeInstanceOf(ContentError)
    await expect(buildLineEmail({ ...base })).rejects.toBeInstanceOf(
      ContentError,
    )
    await expect(
      buildLineEmail({
        ...base,
        format: "text",
        threadKeys: ["bt.key-000001"],
      }),
    ).rejects.toBeInstanceOf(ContentError)
    const many = Array.from(
      { length: LINE_EMAIL_LIMITS.threadKeys + 1 },
      (_, i) => `bt.k-${String(i).padStart(6, "0")}`,
    )
    await expect(
      buildLineEmail({
        ...base,
        format: "text",
        messageKey: "bt.key-000099",
        threadKeys: many,
      }),
    ).rejects.toBeInstanceOf(ContentError)
  })
})
