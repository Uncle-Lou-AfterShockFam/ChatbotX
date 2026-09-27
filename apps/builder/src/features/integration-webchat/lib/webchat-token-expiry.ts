/**
 * Client-side reading of the guest token's `exp` (s210), only to schedule a
 * refresh: the server still verifies every token, so an unreadable one just
 * means "no schedule" (the 403-then-refresh retry still applies).
 */

/** Refresh this long before expiry. */
export const WEBCHAT_TOKEN_REFRESH_LEAD_MS = 2 * 60 * 1000
// setTimeout clamps anything above 2^31 - 1 ms to 1 ms.
const MAX_TIMEOUT_MS = 2 ** 31 - 1
const MAX_TOKEN_LENGTH = 2048
const BASE64URL_DASH = /-/g
const BASE64URL_UNDERSCORE = /_/g

export function webchatTokenExpiresAtMs(
  token: string | null | undefined,
): number | null {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) {
    return null
  }
  const [encoded] = token.split(".")
  if (!encoded) {
    return null
  }
  try {
    const base64 = encoded
      .replace(BASE64URL_DASH, "+")
      .replace(BASE64URL_UNDERSCORE, "/")
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
    const payload = JSON.parse(atob(padded)) as { exp?: unknown } | null
    const exp = payload?.exp
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null
  } catch {
    return null
  }
}

/** Milliseconds until the refresh should run (0 = now), or null for none. */
export function webchatTokenRefreshDelayMs(
  token: string | null | undefined,
  nowMs: number,
): number | null {
  const expiresAt = webchatTokenExpiresAtMs(token)
  if (expiresAt === null) {
    return null
  }
  return Math.min(
    Math.max(0, expiresAt - WEBCHAT_TOKEN_REFRESH_LEAD_MS - nowMs),
    MAX_TIMEOUT_MS,
  )
}
