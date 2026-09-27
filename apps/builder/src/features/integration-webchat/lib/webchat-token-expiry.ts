/**
 * When the widget refreshes its guest token (s210). Timed from when the token
 * ARRIVED, on the client's own clock: the TTL is a duration, so a client clock
 * that is minutes or hours off the server's changes nothing (reading `exp`
 * would, and a clock ahead by more than the TTL looped refreshes).
 */

/** The guest token's lifetime; the server mints with the same value. */
export const TOKEN_TTL_SECONDS = 30 * 60
/** Refresh this long before the token would expire. */
export const WEBCHAT_TOKEN_REFRESH_LEAD_MS = 2 * 60 * 1000
/** Never refresh twice within this long, whatever the caller. */
export const WEBCHAT_TOKEN_MIN_REFRESH_INTERVAL_MS = 60 * 1000

const REFRESH_AFTER_MS =
  TOKEN_TTL_SECONDS * 1000 - WEBCHAT_TOKEN_REFRESH_LEAD_MS

/** Milliseconds until a token received at `receivedAtMs` is due (0 = now). */
export function webchatTokenRefreshDelayMs(
  receivedAtMs: number,
  nowMs: number,
): number {
  const elapsed = nowMs - receivedAtMs
  // A clock that jumped backwards (elapsed < 0): count from now.
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return REFRESH_AFTER_MS
  }
  return Math.max(
    WEBCHAT_TOKEN_MIN_REFRESH_INTERVAL_MS - elapsed,
    REFRESH_AFTER_MS - elapsed,
    0,
  )
}

/** Whether a token received at `receivedAtMs` should be refreshed now. */
export const isWebchatTokenDue = (receivedAtMs: number, nowMs: number) =>
  webchatTokenRefreshDelayMs(receivedAtMs, nowMs) === 0
