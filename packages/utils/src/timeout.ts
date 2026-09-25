/** setTimeout's own ceiling: a larger delay silently becomes 1 ms in Node. */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1

/**
 * Throws a RangeError unless `timeoutMs` is a finite number in
 * (0, MAX_TIMEOUT_MS]. Node turns 0, negatives, NaN, Infinity and anything
 * past the ceiling into a 1 ms timer (with only a process warning), so a
 * caller meaning "no timeout" would get "time out immediately" instead.
 */
export function assertTimeoutMs(timeoutMs: number): void {
  if (
    typeof timeoutMs !== "number" ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new RangeError(
      `timeoutMs must be a finite number in (0, ${MAX_TIMEOUT_MS}], got ${String(timeoutMs)}`,
    )
  }
}

export class TimeoutError extends Error {
  readonly timeoutMs: number

  constructor(message: string, timeoutMs: number) {
    super(message)
    this.name = "TimeoutError"
    this.timeoutMs = timeoutMs
  }
}

/**
 * Settles with `promise`, or rejects with a `TimeoutError` once `timeoutMs`
 * passes first. The timer is always cleared. The abandoned promise keeps
 * running, and a late rejection from it is still handled (Promise.race
 * attaches a handler), so it never surfaces as an unhandledRejection.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message = `operation did not settle within ${timeoutMs}ms`,
): Promise<T> {
  assertTimeoutMs(timeoutMs)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(message, timeoutMs)),
      timeoutMs,
    )
  })
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer)
  })
}
