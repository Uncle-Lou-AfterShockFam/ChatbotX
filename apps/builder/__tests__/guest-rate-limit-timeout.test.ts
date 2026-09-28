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

  test("ONE budget covers every round trip: a slow-but-answering store cannot stack four timeouts", async () => {
    vi.useFakeTimers()
    try {
      // Each call answers just under the budget: bounded per call, the
      // ip + session path (4 round trips) would take ~4x STORE_TIMEOUT_MS.
      const slow = <T>(value: T) =>
        new Promise<T>((resolve) =>
          setTimeout(() => resolve(value), STORE_TIMEOUT_MS - 100),
        )
      const store = {
        setNumberIfNotExists: vi.fn(() => slow(false)),
        incrementCounter: vi.fn(() => slow(2)),
      }
      let settled = false
      const pending = checkGuestRateLimit({
        webchatId: "wc-slow",
        clientIp: "203.0.113.10",
        guestConversationId: "gc-slow",
        store,
        now: 0,
      }).then((result) => {
        settled = true
        return result
      })
      await vi.advanceTimersByTimeAsync(STORE_TIMEOUT_MS)
      expect(settled).toBe(true)
      expect((await pending).limited).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  test("a fast store with a session key is still the source of truth", async () => {
    const store = {
      setNumberIfNotExists: vi.fn(() => Promise.resolve(false)),
      incrementCounter: vi.fn((key: string) =>
        Promise.resolve(key.includes(":session:") ? 999 : 1),
      ),
    }
    const result = await checkGuestRateLimit({
      webchatId: "wc-fast",
      clientIp: "203.0.113.11",
      guestConversationId: "gc-fast",
      store,
      now: 0,
    })
    expect(result.limited).toBe(true)
    expect(store.incrementCounter).toHaveBeenCalledTimes(2)
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

describe("checkGuestRateLimit scope (s210)", () => {
  test("the token-refresh scope has its own keys; the message keys are unchanged", async () => {
    const keys: string[] = []
    const store = {
      setNumberIfNotExists: vi.fn((key: string) => {
        keys.push(key)
        return Promise.resolve(true)
      }),
      incrementCounter: vi.fn(() => Promise.resolve(1)),
    }
    const input = {
      webchatId: "42",
      clientIp: "203.0.113.7",
      guestConversationId: "123:guest",
      store,
      now: 0,
    }
    await checkGuestRateLimit(input)
    await checkGuestRateLimit({ ...input, scope: "token-refresh" })
    expect(keys).toEqual([
      "guest-rate-limit:ip:42:203.0.113.7:0",
      "guest-rate-limit:session:42:123:guest:0",
      "guest-rate-limit:token-refresh:ip:42:203.0.113.7:0",
      "guest-rate-limit:token-refresh:session:42:123:guest:0",
    ])
  })
})

describe("checkGuestRateLimit on the shared fixed window (s218)", () => {
  const countingStore = () => {
    const counts = new Map<string, number>()
    const ttls: number[] = []
    return {
      counts,
      ttls,
      setNumberIfNotExists: vi.fn((key: string, _v: number, ttl: number) => {
        ttls.push(ttl)
        if (counts.has(key)) {
          return Promise.resolve(false)
        }
        counts.set(key, 1)
        return Promise.resolve(true)
      }),
      incrementCounter: vi.fn((key: string, by: number, ttl: number) => {
        ttls.push(ttl)
        const next = (counts.get(key) ?? 0) + by
        counts.set(key, next)
        return Promise.resolve(next)
      }),
    }
  }

  test("keys carry the 10 s window index and a 10 s TTL", async () => {
    const store = countingStore()
    // 25 s in = window 2, 5 s left.
    const result = await checkGuestRateLimit({
      webchatId: "42",
      clientIp: "203.0.113.7",
      guestConversationId: "c1",
      store,
      now: 25_000,
    })
    expect(result).toEqual({ limited: false, retryAfter: 5 })
    expect([...store.counts.keys()]).toEqual([
      "guest-rate-limit:ip:42:203.0.113.7:2",
      "guest-rate-limit:session:42:c1:2",
    ])
    expect(new Set(store.ttls)).toEqual(new Set([10]))
  })

  test("no session key without a guest conversation id", async () => {
    const store = countingStore()
    await checkGuestRateLimit({
      webchatId: "42",
      clientIp: "203.0.113.7",
      store,
      now: 0,
    })
    expect([...store.counts.keys()]).toEqual([
      "guest-rate-limit:ip:42:203.0.113.7:0",
    ])
  })

  test("the session budget trips at 21 and the ip budget at 61", async () => {
    const store = countingStore()
    const hit = (guestConversationId: string) =>
      checkGuestRateLimit({
        webchatId: "42",
        clientIp: "203.0.113.7",
        guestConversationId,
        store,
        now: 0,
      })
    for (let i = 0; i < 20; i++) {
      expect((await hit("a")).limited).toBe(false)
    }
    expect((await hit("a")).limited).toBe(true)
    // ip count is 21; fresh sessions spend the ip budget up to 60.
    for (let i = 0; i < 39; i++) {
      expect((await hit(`s${i}`)).limited).toBe(false)
    }
    expect((await hit("z")).limited).toBe(true)
  })
})

describe("guest limiter fallback log (s218)", () => {
  test("names the webchat, never the client ip", async () => {
    const { logger } = await import("@/lib/log")
    const warn = vi.mocked(logger.warn)
    warn.mockClear()
    const store = {
      setNumberIfNotExists: vi.fn(() => Promise.reject(new Error("down"))),
      incrementCounter: vi.fn(() => Promise.reject(new Error("down"))),
    }
    await checkGuestRateLimit({
      webchatId: "42",
      clientIp: "203.0.113.7",
      store,
      now: 0,
    })
    const context = warn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(context).toMatchObject({ scope: "webchat-guest", webchatId: "42" })
    expect(JSON.stringify(context)).not.toContain("203.0.113.7")
  })
})
