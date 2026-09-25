// @vitest-environment node
import { beforeEach, expect, test, vi } from "vitest"

const verifyDocumensoSecret = vi.fn()
const completeFromWebhook = vi.fn()
const warn = vi.fn()
const error = vi.fn()

vi.mock("@chatbotx.io/business/documents", () => ({
  verifyDocumensoSecret,
  documentSigningService: { completeFromWebhook },
  // Byte-counting stand-in for the streaming reader (tested in business).
  readCapped: async (req: Request, max: number) => {
    const bytes = new Uint8Array(await req.arrayBuffer())
    return bytes.length > max ? null : bytes
  },
}))
vi.mock("@/lib/log", () => ({ logger: { warn, error } }))

const BODY = JSON.stringify({ event: "DOCUMENT_COMPLETED", payload: {} })
const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("http://localhost/integrations/documenso/webhook", {
    method: "POST",
    headers: { "x-documenso-secret": "s3cret", ...headers },
    body,
  })

beforeEach(() => {
  vi.clearAllMocks()
  verifyDocumensoSecret.mockReturnValue("ok")
  completeFromWebhook.mockResolvedValue({
    outcome: "signed",
    detail: "document 1",
  })
})

test("fails closed: no configured secret = 404, wrong or missing header = 401; the body is never read", async () => {
  const { POST } = await import("@/app/integrations/documenso/webhook/route")
  verifyDocumensoSecret.mockReturnValueOnce("not-configured")
  expect((await POST(post(BODY))).status).toBe(404)
  verifyDocumensoSecret.mockReturnValueOnce("invalid")
  expect((await POST(post(BODY))).status).toBe(401)
  expect(verifyDocumensoSecret).toHaveBeenLastCalledWith("s3cret")
  expect(completeFromWebhook).not.toHaveBeenCalled()
})

test("oversized (declared or actual) = 413, not JSON = 400", async () => {
  const { POST, MAX_DOCUMENSO_WEBHOOK_BYTES } = await import(
    "@/app/integrations/documenso/webhook/route"
  )
  const big = "x".repeat(MAX_DOCUMENSO_WEBHOOK_BYTES + 1)
  expect((await POST(post(big))).status).toBe(413)
  expect(
    (
      await POST(
        post("{}", {
          "content-length": String(MAX_DOCUMENSO_WEBHOOK_BYTES + 1),
        }),
      )
    ).status,
  ).toBe(413)
  expect((await POST(post("{not json"))).status).toBe(400)
  expect(completeFromWebhook).not.toHaveBeenCalled()
})

test("a transient outcome answers 503 (Documenso redelivers); final outcomes answer 200", async () => {
  const { POST } = await import("@/app/integrations/documenso/webhook/route")
  completeFromWebhook.mockResolvedValueOnce({
    outcome: "retry",
    detail: "confirm: timeout",
  })
  expect((await POST(post(BODY))).status).toBe(503)
  for (const outcome of [
    "signed",
    "duplicate",
    "ignored",
    "unknown",
    "unconfirmed",
  ]) {
    completeFromWebhook.mockResolvedValueOnce({ outcome, detail: "d" })
    const res = await POST(post(BODY))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome, detail: "d" })
  }
  expect(completeFromWebhook).toHaveBeenCalledWith({ body: JSON.parse(BODY) })
})

test("the cap counts BYTES: a body under the limit in characters but over it in UTF-8 is 413", async () => {
  const { POST, MAX_DOCUMENSO_WEBHOOK_BYTES } = await import(
    "@/app/integrations/documenso/webhook/route"
  )
  const euros = "\u20ac".repeat(Math.floor(MAX_DOCUMENSO_WEBHOOK_BYTES / 2))
  expect(euros.length).toBeLessThan(MAX_DOCUMENSO_WEBHOOK_BYTES)
  expect((await POST(post(JSON.stringify({ e: euros })))).status).toBe(413)
})

test("a thrown service error (DB down, out-of-range id) is a logged 503, not a bare 500", async () => {
  const { POST } = await import("@/app/integrations/documenso/webhook/route")
  completeFromWebhook.mockRejectedValueOnce(new Error("value out of range"))
  const res = await POST(post(BODY))
  expect(res.status).toBe(503)
  expect(error).toHaveBeenCalled()
})
