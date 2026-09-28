// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("@chatbotx.io/redis", () => ({ distributedStore: {} }))
vi.mock("@/lib/log", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

const {
  checkGuestCreateRateLimit,
  GUEST_CREATE_IP_LIMIT,
  GUEST_CREATE_WEBCHAT_LIMIT,
  UNKNOWN_CLIENT_IP,
} = await import("../src/lib/rate-limit/guest-rate-limit")
const { resetFixedWindowMemory } = await import(
  "../src/lib/rate-limit/fixed-window"
)

/** A store that counts in memory but through the real key contract. */
const makeStore = () => {
  const counters = new Map<string, number>()
  return {
    counters,
    setNumberIfNotExists: vi.fn((key: string, value: number) => {
      if (counters.has(key)) {
        return Promise.resolve(false)
      }
      counters.set(key, value)
      return Promise.resolve(true)
    }),
    incrementCounter: vi.fn((key: string, by: number) => {
      const next = (counters.get(key) ?? 0) + by
      counters.set(key, next)
      return Promise.resolve(next)
    }),
  }
}

const now = 1_790_600_000_000

describe("guest creation rate limit (s217)", () => {
  beforeEach(() => resetFixedWindowMemory())

  test("10 new guests per ip per minute, then limited; another ip and the next window are not", async () => {
    const store = makeStore()
    const create = (clientIp: string, at = now) =>
      checkGuestCreateRateLimit({ webchatId: "w1", clientIp, store, now: at })

    for (let i = 0; i < GUEST_CREATE_IP_LIMIT; i++) {
      expect((await create("198.51.100.7")).limited).toBe(false)
    }
    const over = await create("198.51.100.7")
    expect(over.limited).toBe(true)
    expect(over.retryAfter).toBeGreaterThan(0)
    expect(over.retryAfter).toBeLessThanOrEqual(60)
    expect((await create("198.51.100.8")).limited).toBe(false)
    expect((await create("198.51.100.7", now + 60_000)).limited).toBe(false)
  })

  test("the ip bucket spans webchats: rotating the webchat does not reset it", async () => {
    const store = makeStore()
    for (let i = 0; i < GUEST_CREATE_IP_LIMIT; i++) {
      await checkGuestCreateRateLimit({
        webchatId: `w${i}`,
        clientIp: "198.51.100.7",
        store,
        now,
      })
    }
    expect(
      (
        await checkGuestCreateRateLimit({
          webchatId: "w-new",
          clientIp: "198.51.100.7",
          store,
          now,
        })
      ).limited,
    ).toBe(true)
  })

  test("the webchat bucket trips across many ips", async () => {
    const store = makeStore()
    for (let i = 0; i < GUEST_CREATE_WEBCHAT_LIMIT; i++) {
      const r = await checkGuestCreateRateLimit({
        webchatId: "w1",
        clientIp: `10.0.${Math.floor(i / 250)}.${i % 250}`,
        store,
        now,
      })
      expect(r.limited).toBe(false)
    }
    expect(
      (
        await checkGuestCreateRateLimit({
          webchatId: "w1",
          clientIp: "203.0.113.1",
          store,
          now,
        })
      ).limited,
    ).toBe(true)
    // Another webchat is unaffected.
    expect(
      (
        await checkGuestCreateRateLimit({
          webchatId: "w2",
          clientIp: "203.0.113.2",
          store,
          now,
        })
      ).limited,
    ).toBe(false)
  })

  test("an unknown client ip skips the ip bucket instead of sharing one", async () => {
    const store = makeStore()
    for (let i = 0; i < GUEST_CREATE_IP_LIMIT + 5; i++) {
      const r = await checkGuestCreateRateLimit({
        webchatId: "w1",
        clientIp: UNKNOWN_CLIENT_IP,
        store,
        now,
      })
      expect(r.limited).toBe(false)
    }
    expect([...store.counters.keys()].some((k) => k.includes(":ip:"))).toBe(
      false,
    )
  })

  test("a failing store falls back to per-process counting, never to no limit", async () => {
    const store = {
      setNumberIfNotExists: vi.fn(() => Promise.reject(new Error("down"))),
      incrementCounter: vi.fn(() => Promise.reject(new Error("down"))),
    }
    for (let i = 0; i < GUEST_CREATE_IP_LIMIT; i++) {
      await checkGuestCreateRateLimit({
        webchatId: "w1",
        clientIp: "198.51.100.9",
        store,
        now,
      })
    }
    expect(
      (
        await checkGuestCreateRateLimit({
          webchatId: "w1",
          clientIp: "198.51.100.9",
          store,
          now,
        })
      ).limited,
    ).toBe(true)
  })

  test("a hung store takes the fallback within the timeout instead of holding the request", async () => {
    const hung = {
      setNumberIfNotExists: vi.fn(() => new Promise<boolean>(() => undefined)),
      incrementCounter: vi.fn(() => new Promise<number>(() => undefined)),
    }
    const started = Date.now()
    const r = await checkGuestCreateRateLimit({
      webchatId: "w1",
      clientIp: "198.51.100.10",
      store: hung,
      now,
      storeTimeoutMs: 50,
    })
    expect(r.limited).toBe(false)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
