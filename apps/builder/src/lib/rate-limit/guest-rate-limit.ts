import {
  checkFixedWindow,
  type FixedWindowBucket,
  type FixedWindowResult,
  type FixedWindowStore,
  windowSuffix,
} from "./fixed-window"

const WINDOW_SECONDS = 10
const IP_LIMIT = 60
const SESSION_LIMIT = 20

type GuestRateLimitInput = {
  webchatId: string
  clientIp: string
  guestConversationId?: string | null
  /**
   * A separate budget for a separate endpoint (s210: the guest-token refresh
   * must neither starve nor be starved by message sends). Omitted = the
   * message budget, keys unchanged.
   */
  scope?: "token-refresh"
  store?: FixedWindowStore
  now?: number
  /** Test seam; app code keeps the default `STORE_TIMEOUT_MS`. */
  storeTimeoutMs?: number
}

const buildRateLimitKey = (...parts: string[]) =>
  ["guest-rate-limit", ...parts].join(":")

/**
 * Per-ip then per-session message budget on the shared fixed window
 * (s218: was a hand-rolled copy of `checkFixedWindow`; the key strings are
 * unchanged so an in-flight window survives the deploy).
 */
export const checkGuestRateLimit = async ({
  webchatId,
  clientIp,
  guestConversationId,
  scope,
  store,
  now = Date.now(),
  storeTimeoutMs,
}: GuestRateLimitInput): Promise<FixedWindowResult> => {
  const suffix = windowSuffix(now, WINDOW_SECONDS)
  const scoped = scope ? [scope] : []
  const buckets: FixedWindowBucket[] = [
    {
      key: buildRateLimitKey(...scoped, "ip", webchatId, clientIp, suffix),
      limit: IP_LIMIT,
    },
  ]
  if (guestConversationId) {
    buckets.push({
      key: buildRateLimitKey(
        ...scoped,
        "session",
        webchatId,
        guestConversationId,
        suffix,
      ),
      limit: SESSION_LIMIT,
    })
  }
  return await checkFixedWindow({
    buckets,
    windowSeconds: WINDOW_SECONDS,
    store,
    now,
    scope: scope ? `webchat-guest-${scope}` : "webchat-guest",
    storeTimeoutMs,
  })
}

// What `getGuestClientIp` returns when no proxy header identifies the caller
// at all — every such request shares one rate-limit bucket, so a caller that
// has a better per-client identity of its own should substitute it via
// `resolveGuestRateLimitKey`.
export const UNKNOWN_CLIENT_IP = "unknown"

// Trusts the first `x-forwarded-for` hop as the client IP. This is only
// correct behind a proxy that overwrites (not appends to) the header before
// forwarding — otherwise a caller can set an arbitrary `X-Forwarded-For` to
// rotate their rate-limit key (evasion) or pin a victim's IP (lockout).
// Confirm the deployment's ingress/proxy strips inbound XFF before trusting
// this for anything beyond best-effort abuse mitigation.
export const getGuestClientIp = (headers: Headers) => {
  const forwardedFor = headers.get("x-forwarded-for")
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || UNKNOWN_CLIENT_IP
  }

  return headers.get("x-real-ip")?.trim() || UNKNOWN_CLIENT_IP
}

/**
 * The `clientIp` bucket key for a guest endpoint that can identify its caller
 * without a proxy header.
 *
 * Deployments with no header-setting proxy hand every request the same
 * `UNKNOWN_CLIENT_IP`, which collapses all callers into a single bucket and
 * makes a busy endpoint 429 for everyone. `fallbackKey` should be an
 * identity the caller cannot forge — a value read out of a signed token,
 * never anything taken straight from request input.
 */
export const resolveGuestRateLimitKey = (
  headers: Headers,
  fallbackKey: string,
) => {
  const clientIp = getGuestClientIp(headers)
  return clientIp === UNKNOWN_CLIENT_IP ? fallbackKey : clientIp
}

/**
 * Guest CREATION limiter (s217): every first message from a fresh guest id
 * inserts a Contact, ContactInbox and Conversation, and a guest id costs one
 * page load to mint, so the per-session message budget above never bounds
 * it. Checked only on the branch that creates the contact: 10 new guests per
 * minute per client ip, across every webchat.
 *
 * Deliberately NO shared per-webchat bucket (s217 skeptic): ~30 ips could
 * hold it full and 429 every genuine new visitor of a victim's webchat, a
 * lockout worse than the spam it bounds. The workspace MAC quota stays the
 * ceiling on total contacts. A caller with no proxy header
 * (`UNKNOWN_CLIENT_IP`) is not limited here rather than share one bucket
 * with every other such caller (the netcup Caddy always sets the header).
 */
const CREATE_WINDOW_SECONDS = 60
export const GUEST_CREATE_IP_LIMIT = 10

export const checkGuestCreateRateLimit = async ({
  clientIp,
  store,
  now = Date.now(),
  storeTimeoutMs,
}: {
  clientIp: string
  store?: FixedWindowStore
  now?: number
  storeTimeoutMs?: number
}): Promise<FixedWindowResult> => {
  if (clientIp === UNKNOWN_CLIENT_IP) {
    return { limited: false, retryAfter: 0 }
  }
  const suffix = windowSuffix(now, CREATE_WINDOW_SECONDS)
  return await checkFixedWindow({
    buckets: [
      {
        key: ["guest-create-rate-limit", "ip", clientIp, suffix].join(":"),
        limit: GUEST_CREATE_IP_LIMIT,
      },
    ],
    windowSeconds: CREATE_WINDOW_SECONDS,
    store,
    now,
    scope: "webchat-guest-create",
    storeTimeoutMs,
  })
}
