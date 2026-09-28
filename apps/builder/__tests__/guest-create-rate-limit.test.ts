// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("@chatbotx.io/redis", () => ({ distributedStore: {} }))
vi.mock("@/lib/log", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

const { checkGuestCreateRateLimit, GUEST_CREATE_IP_LIMIT, UNKNOWN_CLIENT_IP } =
  await import("../src/lib/rate-limit/guest-rate-limit")
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
      checkGuestCreateRateLimit({ clientIp, store, now: at })

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

  test("many ips never lock out a new visitor from another ip (no shared per-webchat bucket)", async () => {
    const store = makeStore()
    for (let i = 0; i < 1000; i++) {
      await checkGuestCreateRateLimit({
        clientIp: `10.${Math.floor(i / 250)}.0.${i % 250}`,
        store,
        now,
      })
    }
    expect(
      (await checkGuestCreateRateLimit({ clientIp: "203.0.113.1", store, now }))
        .limited,
    ).toBe(false)
  })

  test("an unknown client ip is not limited and never touches the store", async () => {
    const store = makeStore()
    for (let i = 0; i < GUEST_CREATE_IP_LIMIT + 5; i++) {
      const r = await checkGuestCreateRateLimit({
        clientIp: UNKNOWN_CLIENT_IP,
        store,
        now,
      })
      expect(r.limited).toBe(false)
    }
    expect(store.setNumberIfNotExists).not.toHaveBeenCalled()
  })

  test("a failing store falls back to per-process counting, never to no limit", async () => {
    const store = {
      setNumberIfNotExists: vi.fn(() => Promise.reject(new Error("down"))),
      incrementCounter: vi.fn(() => Promise.reject(new Error("down"))),
    }
    for (let i = 0; i < GUEST_CREATE_IP_LIMIT; i++) {
      await checkGuestCreateRateLimit({ clientIp: "198.51.100.9", store, now })
    }
    expect(
      (
        await checkGuestCreateRateLimit({
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
      clientIp: "198.51.100.10",
      store: hung,
      now,
      storeTimeoutMs: 50,
    })
    expect(r.limited).toBe(false)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test("a store call that lands AFTER the timeout only over-counts: the decision already came from the fallback", async () => {
    const store = makeStore()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow = {
      setNumberIfNotExists: vi.fn(async (key: string, value: number) => {
        await gate
        return store.setNumberIfNotExists(key, value)
      }),
      incrementCounter: vi.fn(async (key: string, by: number) => {
        await gate
        return store.incrementCounter(key, by)
      }),
    }
    const r = await checkGuestCreateRateLimit({
      clientIp: "198.51.100.11",
      store: slow,
      now,
      storeTimeoutMs: 20,
    })
    expect(r.limited).toBe(false)
    release?.()
    await vi.waitFor(() => expect(store.counters.size).toBe(1))
    // The late write counted the request once in the store: an over-count
    // that can only trip the limit early, never admit extra traffic.
    expect([...store.counters.values()]).toEqual([1])
  })
})
