// @vitest-environment node

import { describe, expect, test, vi } from "vitest"

vi.mock("@/lib/log", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}))

vi.mock("@chatbotx.io/redis", () => ({
  distributedStore: {
    incrWithWindow: vi.fn(),
    incrementCounter: vi.fn(),
    setNumberIfNotExists: vi.fn(),
  },
}))

const { checkGuestRateLimit } = await import(
  "../src/lib/rate-limit/guest-rate-limit"
)
const { STORE_TIMEOUT_MS } = await import(
  "../src/lib/rate-limit/api-rate-limit"
)

// A Redis that accepted the socket but stopped answering.
const neverSettles = (): void => undefined

const hungStore = () => ({
  setNumberIfNotExists: vi.fn(() => new Promise<boolean>(neverSettles)),
  incrementCounter: vi.fn(() => new Promise<number>(neverSettles)),
})

describe("checkGuestRateLimit with a hung store (s201c)", () => {
  test("gives up at the store timeout and answers from the local fallback", async () => {
    vi.useFakeTimers()
    try {
      let settled = false
      const pending = checkGuestRateLimit({
        webchatId: "wc-hung",
        clientIp: "203.0.113.7",
        store: hungStore(),
        now: 0,
      }).then((result) => {
        settled = true
        return result
      })
      await vi.advanceTimersByTimeAsync(STORE_TIMEOUT_MS - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect((await pending).limited).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  test("the fallback still enforces the per-IP limit while the store hangs", async () => {
    const store = hungStore()
    const results = await Promise.all(
      Array.from({ length: 61 }, () =>
        checkGuestRateLimit({
          webchatId: "wc-hung-limit",
          clientIp: "203.0.113.8",
          store,
          now: 0,
          storeTimeoutMs: 5,
        }),
      ),
    )
    expect(results.filter((r) => r.limited)).toHaveLength(1)
  })

  test.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("refuses storeTimeoutMs %s instead of silently running on the local counter", async (bad) => {
    await expect(
      checkGuestRateLimit({
        webchatId: "wc",
        clientIp: "203.0.113.9",
        store: hungStore(),
        storeTimeoutMs: bad,
      }),
    ).rejects.toThrow(RangeError)
  })
})
