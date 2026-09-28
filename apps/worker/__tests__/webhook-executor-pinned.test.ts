import { beforeEach, describe, expect, test, vi } from "vitest"

// s216: a webhook is POSTed only through the SSRF-pinned outboundFetch (checked
// at connect and on every redirect hop), a refusal is not retried, and a
// socket failure (errno on `cause`) IS retried.
const mocks = vi.hoisted(() => ({
  assertPublicUrl: vi.fn(async () => undefined),
  outboundFetch: vi.fn(),
}))

vi.mock("@chatbotx.io/business", () => ({
  assertPublicUrl: mocks.assertPublicUrl,
  outboundFetch: mocks.outboundFetch,
}))
vi.mock("../src/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { WebhookExecutor } = await import(
  "../src/webhook/services/webhook-executor.service"
)

type ExecuteInput = Parameters<WebhookExecutor["execute"]>[0]
const webhook = {
  id: "wh-1",
  url: "https://hooks.example.com/in",
} as unknown as ExecuteInput["webhook"]
const payload = { event: "x" } as unknown as ExecuteInput["payload"]

class SsrfFetchError extends Error {
  constructor() {
    super("[ssrf-guard] unsafeAddress: hooks.example.com")
    this.name = "SsrfFetchError"
  }
}

describe("WebhookExecutor pinned delivery (s216)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mocks.outboundFetch.mockReset()
  })

  test("POSTs through outboundFetch with a 30 s deadline and releases the body", async () => {
    const cancel = vi.fn(async () => undefined)
    mocks.outboundFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: { cancel },
    })
    await new WebhookExecutor().execute({ webhook, payload })
    expect(mocks.outboundFetch).toHaveBeenCalledWith(
      "https://hooks.example.com/in",
      expect.objectContaining({ method: "POST", body: '{"event":"x"}' }),
      { timeoutMs: 30_000 },
    )
    expect(cancel).toHaveBeenCalled()
  })

  test("a refusal (rebinding / redirect to private) is not retried", async () => {
    mocks.outboundFetch.mockRejectedValue(new SsrfFetchError())
    await new WebhookExecutor().execute({ webhook, payload })
    expect(mocks.outboundFetch).toHaveBeenCalledTimes(1)
  })

  test("a reset after sending is NOT retried (the receiver may have committed it)", async () => {
    const reset = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNRESET", message: "read ECONNRESET" },
    })
    mocks.outboundFetch.mockRejectedValue(reset)
    await new WebhookExecutor().execute({ webhook, payload })
    expect(mocks.outboundFetch).toHaveBeenCalledTimes(1)
  })

  test("a connect-phase failure reported on `cause` is retried", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED" },
    })
    mocks.outboundFetch.mockRejectedValue(refused)
    await new WebhookExecutor().execute({ webhook, payload })
    expect(mocks.outboundFetch.mock.calls.length).toBeGreaterThan(1)
  })
})
