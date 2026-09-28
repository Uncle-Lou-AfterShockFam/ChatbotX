import { beforeEach, describe, expect, test, vi } from "vitest"

// s216: the signed envelope is POSTed only through the SSRF-pinned
// outboundFetch; ky used to follow a 307/308 and re-POST it to a host nobody
// checked. A non-2xx still throws, as ky's HTTPError did.
const mocks = vi.hoisted(() => ({
  assertPublicUrl: vi.fn(async () => undefined),
  outboundFetch: vi.fn(),
}))

vi.mock("@chatbotx.io/business", () => ({
  assertPublicUrl: mocks.assertPublicUrl,
}))
vi.mock("@chatbotx.io/business/outbound-fetch", () => ({
  outboundFetch: mocks.outboundFetch,
}))

const SIGNATURE = /^sha256=[0-9a-f]{64}$/

const { DeliveryHttpError, postSignedEnvelope } = await import(
  "../src/lib/delivery"
)

const args = {
  callbackUrl: "https://customer.example.com/hook",
  signingSecret: "secret",
  envelope: { hello: "world" },
}

describe("postSignedEnvelope (s216)", () => {
  beforeEach(() => {
    mocks.outboundFetch.mockReset()
    mocks.assertPublicUrl.mockClear()
  })

  test("POSTs the signed body through the pinned fetch with the 30 s deadline", async () => {
    mocks.outboundFetch.mockResolvedValue(
      new Response('{"messageId":"m-1"}', { status: 200 }),
    )
    const result = await postSignedEnvelope(args)
    expect(result).toEqual({ messageId: "m-1" })
    expect(mocks.assertPublicUrl).toHaveBeenCalledWith(
      args.callbackUrl,
      "API channel callback URL",
    )
    const [url, init, options] = mocks.outboundFetch.mock.calls[0] as [
      string,
      { method: string; body: string; headers: Record<string, string> },
      { timeoutMs: number },
    ]
    expect(url).toBe(args.callbackUrl)
    expect(init.method).toBe("POST")
    expect(init.body).toBe('{"hello":"world"}')
    expect(init.headers["X-ChatbotX-Signature"]).toMatch(SIGNATURE)
    expect(options).toEqual({ timeoutMs: 30_000 })
  })

  test("a non-2xx answer throws DeliveryHttpError with the status", async () => {
    mocks.outboundFetch.mockResolvedValue(new Response("no", { status: 502 }))
    await expect(postSignedEnvelope(args)).rejects.toMatchObject({
      name: "DeliveryHttpError",
      status: 502,
    })
    expect(DeliveryHttpError).toBeDefined()
  })

  test("an empty or non-JSON 2xx body is null", async () => {
    mocks.outboundFetch.mockResolvedValue(new Response("", { status: 200 }))
    expect(await postSignedEnvelope(args)).toBeNull()
    mocks.outboundFetch.mockResolvedValue(new Response("ok", { status: 200 }))
    expect(await postSignedEnvelope(args)).toBeNull()
  })

  test("a pinned-fetch refusal propagates (never a plain-fetch fallback)", async () => {
    const refusal = Object.assign(new Error("[ssrf-guard] unsafeRedirect"), {
      name: "SsrfFetchError",
    })
    mocks.outboundFetch.mockRejectedValue(refusal)
    await expect(postSignedEnvelope(args)).rejects.toBe(refusal)
  })
})
