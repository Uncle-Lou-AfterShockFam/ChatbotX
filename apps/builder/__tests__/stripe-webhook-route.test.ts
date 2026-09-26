// @vitest-environment node
import { beforeEach, expect, test, vi } from "vitest"

const handleStripeWebhook = vi.fn()
const warn = vi.fn()
const error = vi.fn()

vi.mock("@chatbotx.io/business/invoice", () => ({ handleStripeWebhook }))
vi.mock("@chatbotx.io/business/documents", () => ({
  // Byte-counting stand-in for the streaming reader (tested in business).
  readCapped: async (req: Request, max: number) => {
    const bytes = new Uint8Array(await req.arrayBuffer())
    return bytes.length > max ? null : bytes
  },
  verifyDocumensoSecret: vi.fn(),
  documentSigningService: {},
}))
vi.mock("@/lib/log", () => ({ logger: { warn, error } }))
const checkApiRateLimit = vi.fn()
vi.mock("@/lib/rate-limit/api-rate-limit", () => ({ checkApiRateLimit }))

const BODY = '{"id":"evt_1","type":"invoice.paid"}'
const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("http://localhost/integrations/stripe/webhook/123", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=abc", ...headers },
    body,
  })
const ctx = (integrationId = "123") => ({
  params: Promise.resolve({ integrationId }),
})

beforeEach(() => {
  vi.clearAllMocks()
  checkApiRateLimit.mockResolvedValue({ limited: false, retryAfter: 1 })
  handleStripeWebhook.mockResolvedValue({ outcome: "applied", detail: "x" })
})

test("hands the EXACT raw bytes, the signature header and the path id to the verifier", async () => {
  const { POST } = await import(
    "@/app/integrations/stripe/webhook/[integrationId]/route"
  )
  const res = await POST(post(BODY), ctx())
  expect(res.status).toBe(200)
  const call = handleStripeWebhook.mock.calls[0]?.[0]
  expect(call.integrationId).toBe("123")
  expect(call.signature).toBe("t=1,v1=abc")
  expect(Buffer.isBuffer(call.rawBody)).toBe(true)
  expect(call.rawBody.toString("utf8")).toBe(BODY)
})

test("missing signature header reaches the verifier as null (it rejects)", async () => {
  const { POST } = await import(
    "@/app/integrations/stripe/webhook/[integrationId]/route"
  )
  handleStripeWebhook.mockResolvedValueOnce({
    outcome: "rejected",
    detail: "missing signature",
  })
  const res = await POST(
    new Request("http://localhost/x", { method: "POST", body: BODY }),
    ctx(),
  )
  expect(res.status).toBe(400)
  expect(handleStripeWebhook.mock.calls[0]?.[0].signature).toBeNull()
})

test.each([
  ["applied", 200],
  ["noop", 200],
  ["duplicate", 200],
  ["ignored", 200],
  ["retry", 503],
  ["rejected", 400],
  ["unknown", 400],
] as const)("outcome %s answers %i and never echoes the detail", async (outcome, status) => {
  const { POST } = await import(
    "@/app/integrations/stripe/webhook/[integrationId]/route"
  )
  handleStripeWebhook.mockResolvedValueOnce({ outcome, detail: "secret-ish" })
  const res = await POST(post(BODY), ctx())
  expect(res.status).toBe(status)
  expect(await res.text()).not.toContain("secret-ish")
})

test("an unknown integration and a bad signature give the SAME answer (no id oracle)", async () => {
  const { POST } = await import(
    "@/app/integrations/stripe/webhook/[integrationId]/route"
  )
  handleStripeWebhook.mockResolvedValueOnce({ outcome: "unknown", detail: "a" })
  const unknown = await POST(post(BODY), ctx("999"))
  handleStripeWebhook.mockResolvedValueOnce({
    outcome: "rejected",
    detail: "b",
  })
  const rejected = await POST(post(BODY), ctx())
  expect(unknown.status).toBe(rejected.status)
  expect(await unknown.text()).toBe(await rejected.text())
})

test("a thrown handler answers 503 so Stripe redelivers", async () => {
  const { POST } = await import(
    "@/app/integrations/stripe/webhook/[integrationId]/route"
  )
  handleStripeWebhook.mockRejectedValueOnce(new Error("db down"))
  expect((await POST(post(BODY), ctx())).status).toBe(503)
})

test("oversized (declared or actual) = 413 before the verifier runs", async () => {
  const { POST, MAX_STRIPE_WEBHOOK_BYTES } = await import(
    "@/app/integrations/stripe/webhook/[integrationId]/route"
  )
  const big = "x".repeat(MAX_STRIPE_WEBHOOK_BYTES + 1)
  expect((await POST(post(big), ctx())).status).toBe(413)
  expect(
    (
      await POST(
        post("{}", { "content-length": String(MAX_STRIPE_WEBHOOK_BYTES + 1) }),
        ctx(),
      )
    ).status,
  ).toBe(413)
  expect(handleStripeWebhook).not.toHaveBeenCalled()
})

test("rate limited = 429 with retry-after, keyed on the rightmost proxy hop", async () => {
  const { POST } = await import(
    "@/app/integrations/stripe/webhook/[integrationId]/route"
  )
  checkApiRateLimit.mockResolvedValueOnce({ limited: true, retryAfter: 7 })
  const res = await POST(
    post(BODY, { "x-forwarded-for": "6.6.6.6, 10.0.0.9" }),
    ctx(),
  )
  expect(res.status).toBe(429)
  expect(res.headers.get("retry-after")).toBe("7")
  expect(checkApiRateLimit.mock.calls[0]?.[0]).toMatchObject({
    scope: "stripe-webhook-rate-limit",
    key: "10.0.0.9",
  })
  expect(handleStripeWebhook).not.toHaveBeenCalled()
})
