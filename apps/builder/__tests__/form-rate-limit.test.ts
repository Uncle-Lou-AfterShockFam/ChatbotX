// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("@chatbotx.io/redis", () => ({ distributedStore: {} }))
vi.mock("@/lib/log", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

const { checkFormRateLimit, resetFormRateLimitMemory } = await import(
  "../src/lib/rate-limit/form-rate-limit"
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

describe("form submit rate limit (s200)", () => {
  beforeEach(() => resetFormRateLimitMemory())

  test("60 per ip per minute, then 429 with a Retry-After inside the window", async () => {
    const store = makeStore()
    const now = 1_758_800_000_000
    for (let i = 0; i < 60; i++) {
      const r = await checkFormRateLimit({
        formId: "f1",
        clientIp: "1.1.1.1",
        store,
        now,
      })
      expect(r.limited).toBe(false)
    }
    const r = await checkFormRateLimit({
      formId: "f1",
      clientIp: "1.1.1.1",
      store,
      now,
    })
    expect(r.limited).toBe(true)
    expect(r.retryAfter).toBeGreaterThan(0)
    expect(r.retryAfter).toBeLessThanOrEqual(60)
    // another ip is unaffected; the next window resets
    expect(
      (
        await checkFormRateLimit({
          formId: "f1",
          clientIp: "2.2.2.2",
          store,
          now,
        })
      ).limited,
    ).toBe(false)
    expect(
      (
        await checkFormRateLimit({
          formId: "f1",
          clientIp: "1.1.1.1",
          store,
          now: now + 60_000,
        })
      ).limited,
    ).toBe(false)
  })

  test("600 per form per minute across ips", async () => {
    const store = makeStore()
    const now = 1_758_800_000_000
    for (let i = 0; i < 600; i++) {
      await checkFormRateLimit({
        formId: "f2",
        clientIp: `10.0.${Math.floor(i / 50)}.${i % 50}`,
        store,
        now,
      })
    }
    const r = await checkFormRateLimit({
      formId: "f2",
      clientIp: "9.9.9.9",
      store,
      now,
    })
    expect(r.limited).toBe(true)
  })

  test("a failing store falls back to the in-memory window and still limits", async () => {
    const store = {
      setNumberIfNotExists: vi.fn(() =>
        Promise.reject(new Error("redis down")),
      ),
      incrementCounter: vi.fn(() => Promise.reject(new Error("redis down"))),
    }
    const now = 1_758_800_000_000
    let limited = false
    for (let i = 0; i < 61; i++) {
      limited = (
        await checkFormRateLimit({
          formId: "f3",
          clientIp: "3.3.3.3",
          store,
          now,
        })
      ).limited
    }
    expect(limited).toBe(true)
  })
})
