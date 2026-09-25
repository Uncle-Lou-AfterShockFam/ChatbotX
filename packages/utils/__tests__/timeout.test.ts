import { afterEach, describe, expect, test, vi } from "vitest"
import {
  assertTimeoutMs,
  MAX_TIMEOUT_MS,
  TimeoutError,
  withTimeout,
} from "../src/timeout"

const neverSettles = (): void => undefined

describe("withTimeout", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test("resolves with the promise when it settles first, and clears its timer", async () => {
    vi.useFakeTimers()
    const result = withTimeout(Promise.resolve(7), 1000)
    await expect(result).resolves.toBe(7)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("passes the promise's own rejection through untouched", async () => {
    const boom = new Error("boom")
    await expect(withTimeout(Promise.reject(boom), 1000)).rejects.toBe(boom)
  })

  test("rejects with a TimeoutError at exactly timeoutMs for a promise that never settles", async () => {
    vi.useFakeTimers()
    let outcome: unknown
    const pending = withTimeout(new Promise<number>(neverSettles), 50).catch(
      (error: unknown) => {
        outcome = error
      },
    )
    await vi.advanceTimersByTimeAsync(49)
    expect(outcome).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(outcome).toBeInstanceOf(TimeoutError)
    expect((outcome as TimeoutError).timeoutMs).toBe(50)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("a late rejection after the timeout is handled (no unhandledRejection)", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)
    try {
      const late = new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error("late")), 20),
      )
      await expect(withTimeout(late, 5)).rejects.toBeInstanceOf(TimeoutError)
      await new Promise((resolve) => setTimeout(resolve, 40))
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MAX_TIMEOUT_MS + 1,
  ])("refuses timeoutMs %s synchronously instead of turning it into 1 ms", (bad) => {
    expect(() => withTimeout(Promise.resolve(1), bad)).toThrow(RangeError)
  })

  test("refuses a non-number timeout", () => {
    expect(() => assertTimeoutMs("50" as unknown as number)).toThrow(RangeError)
    expect(() => assertTimeoutMs(undefined as unknown as number)).toThrow(
      RangeError,
    )
  })

  test("accepts the bounds of the valid range", () => {
    expect(() => assertTimeoutMs(1)).not.toThrow()
    expect(() => assertTimeoutMs(MAX_TIMEOUT_MS)).not.toThrow()
  })

  test("stress: 2000 concurrent hung promises all time out together, in real time", async () => {
    const started = performance.now()
    const results = await Promise.allSettled(
      Array.from({ length: 2000 }, () =>
        withTimeout(new Promise<number>(neverSettles), 20),
      ),
    )
    const elapsed = performance.now() - started
    expect(
      results.every(
        (r) => r.status === "rejected" && r.reason instanceof TimeoutError,
      ),
    ).toBe(true)
    // One shared deadline, not 2000 serial ones: well under a second.
    expect(elapsed).toBeLessThan(1000)
  })
})
