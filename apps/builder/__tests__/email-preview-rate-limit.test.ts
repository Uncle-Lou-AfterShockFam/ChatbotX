// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("@chatbotx.io/redis", () => ({ distributedStore: {} }))
vi.mock("@/lib/log", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

const {
  checkEmailPreviewRateLimit,
  EMAIL_PREVIEW_LIMIT,
  EmailPreviewRateLimitInputError,
  resetEmailPreviewRateLimitMemory,
} = await import("../src/lib/rate-limit/email-preview-rate-limit")

const makeStore = () => {
  const counters = new Map<string, number>()
  return {
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

describe("email preview limit (s221b skeptic MEDIUM)", () => {
  beforeEach(() => resetEmailPreviewRateLimitMemory())

  test(`${EMAIL_PREVIEW_LIMIT} previews per user per minute, the next is limited`, async () => {
    const store = makeStore()
    const input = { userId: "u-1", store, now: NOW }
    for (let i = 0; i < EMAIL_PREVIEW_LIMIT; i++) {
      expect((await checkEmailPreviewRateLimit(input)).limited).toBe(false)
    }
    const r = await checkEmailPreviewRateLimit(input)
    expect(r.limited).toBe(true)
    expect(r.retryAfter).toBeGreaterThan(0)
  })

  test("another user and the next window are independent", async () => {
    const store = makeStore()
    for (let i = 0; i <= EMAIL_PREVIEW_LIMIT; i++) {
      await checkEmailPreviewRateLimit({ userId: "u-1", store, now: NOW })
    }
    expect(
      (await checkEmailPreviewRateLimit({ userId: "u-2", store, now: NOW }))
        .limited,
    ).toBe(false)
    expect(
      (
        await checkEmailPreviewRateLimit({
          userId: "u-1",
          store,
          now: NOW + 61_000,
        })
      ).limited,
    ).toBe(false)
  })

  test("a missing user is a typed error, never an unkeyed bucket", () => {
    for (const bad of [undefined, null, {}, { userId: "" }]) {
      expect(() => checkEmailPreviewRateLimit(bad as never)).toThrow(
        EmailPreviewRateLimitInputError,
      )
    }
  })
})
