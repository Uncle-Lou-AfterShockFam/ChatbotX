// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("@chatbotx.io/redis", () => ({ distributedStore: {} }))
vi.mock("@/lib/log", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

const {
  checkDynamicImageRateLimit,
  DYNAMIC_IMAGE_RENDER_LIMIT,
  DynamicImageRateLimitInputError,
  resetDynamicImageRateLimitMemory,
} = await import("../src/lib/rate-limit/dynamic-image-rate-limit")

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

const NOW = 1_759_000_000_000

describe("dynamic-image render limit (s219)", () => {
  beforeEach(() => resetDynamicImageRateLimitMemory())

  test("6 renders per (image, contact) per minute, the 7th is limited", async () => {
    const store = makeStore()
    const input = { dynamicImageId: "img-1", contactId: "c-1", store, now: NOW }
    for (let i = 0; i < DYNAMIC_IMAGE_RENDER_LIMIT; i++) {
      expect((await checkDynamicImageRateLimit(input)).limited).toBe(false)
    }
    const r = await checkDynamicImageRateLimit(input)
    expect(r.limited).toBe(true)
    expect(r.retryAfter).toBeGreaterThan(0)
    expect(r.retryAfter).toBeLessThanOrEqual(60)
  })

  test("another contact, another image and the next window are independent", async () => {
    const store = makeStore()
    const base = { dynamicImageId: "img-1", contactId: "c-1", store, now: NOW }
    for (let i = 0; i <= DYNAMIC_IMAGE_RENDER_LIMIT; i++) {
      await checkDynamicImageRateLimit(base)
    }
    expect((await checkDynamicImageRateLimit(base)).limited).toBe(true)
    expect(
      (await checkDynamicImageRateLimit({ ...base, contactId: "c-2" })).limited,
    ).toBe(false)
    expect(
      (await checkDynamicImageRateLimit({ ...base, dynamicImageId: "img-2" }))
        .limited,
    ).toBe(false)
    expect(
      (await checkDynamicImageRateLimit({ ...base, now: NOW + 60_000 }))
        .limited,
    ).toBe(false)
  })

  test("a store that is down falls back to memory, still limits, logs no contact", async () => {
    const { logger } = await import("@/lib/log")
    const warn = vi.mocked(logger.warn)
    warn.mockClear()
    const store = {
      setNumberIfNotExists: vi.fn(() => Promise.reject(new Error("down"))),
      incrementCounter: vi.fn(() => Promise.reject(new Error("down"))),
    }
    const input = { dynamicImageId: "img-9", contactId: "c-9", store, now: NOW }
    for (let i = 0; i < DYNAMIC_IMAGE_RENDER_LIMIT; i++) {
      expect((await checkDynamicImageRateLimit(input)).limited).toBe(false)
    }
    expect((await checkDynamicImageRateLimit(input)).limited).toBe(true)
    const context = warn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(context).toMatchObject({
      scope: "dynamic-image-render",
      dynamicImageId: "img-9",
    })
    expect(JSON.stringify(context)).not.toContain("c-9")
  })

  test.each([
    ["null input", null],
    ["undefined input", undefined],
    ["an empty image id", { dynamicImageId: "", contactId: "c-1" }],
    ["an empty contact id", { dynamicImageId: "img-1", contactId: "" }],
    ["a missing contact id", { dynamicImageId: "img-1" }],
  ])("%s is a typed refusal", (_label, bad) => {
    expect(() =>
      checkDynamicImageRateLimit(
        bad as unknown as Parameters<typeof checkDynamicImageRateLimit>[0],
      ),
    ).toThrow(DynamicImageRateLimitInputError)
  })

  test("a burst of 50 concurrent checks admits exactly 6", async () => {
    const store = makeStore()
    const input = { dynamicImageId: "img-1", contactId: "c-1", store, now: NOW }
    const results = await Promise.all(
      Array.from({ length: 50 }, () => checkDynamicImageRateLimit(input)),
    )
    expect(results.filter((r) => !r.limited)).toHaveLength(
      DYNAMIC_IMAGE_RENDER_LIMIT,
    )
  })
})
