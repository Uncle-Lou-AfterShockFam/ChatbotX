import { ChatbotXException } from "@chatbotx.io/business/errors"
import { distributedStore } from "@chatbotx.io/redis"
import { assertTimeoutMs, withTimeout } from "@chatbotx.io/utils"
import { logger } from "@/lib/log"

const WINDOW_SECONDS = 10
const REQUEST_LIMIT = 120
const TOO_MANY_REQUESTS_STATUS = 429
// Exported for the eviction regression test only — never touch in app code.
export const memoryCounters = new Map<
  string,
  { count: number; expiresAt: number }
>()

type RateLimitStore = Pick<typeof distributedStore, "incrWithWindow">

/**
 * Closed set of rate-limit bucket names: the scope is joined verbatim into
 * the store key, so a free-form string would let a typo silently split a
 * bucket in two and disable the limit. Extend the union when adding a
 * surface.
 */
export type ApiRateLimitScope =
  | "channel-api-rate-limit"
  | "workspace-token-rate-limit"
  | "workspace-token-preauth-rate-limit"
  | "documenso-webhook-rate-limit"
  | "stripe-webhook-rate-limit"

type ApiRateLimitInput = {
  scope: ApiRateLimitScope
  /** The authenticated identity being limited (inbox id, workspace id, ...). */
  key: string
  /**
   * Requests allowed per window. Defaults to the per-identity limit; pass a
   * higher ceiling for coarse pre-auth buckets (e.g. per-IP) that aggregate
   * many identities behind one key.
   */
  limit?: number
  store?: RateLimitStore
  now?: number
  /** Test seam; app code keeps the default `STORE_TIMEOUT_MS`. */
  storeTimeoutMs?: number
}

type ApiRateLimitResult = {
  limited: boolean
  retryAfter: number
}

const buildRateLimitKey = (scope: string, key: string, windowSuffix: string) =>
  [scope, key, windowSuffix].join(":")

// Fixed-window bucketing, same rationale as guest-rate-limit.ts: fold the
// window index into the key so a steady sender can't keep extending one
// key's TTL indefinitely.
const buildWindowSuffix = (now: number, windowSeconds: number) =>
  String(Math.floor(now / (windowSeconds * 1000)))

const secondsUntilNextWindow = (now: number, windowSeconds: number) => {
  const windowMs = windowSeconds * 1000
  const elapsed = now % windowMs
  return Math.ceil((windowMs - elapsed) / 1000)
}

// Expired fallback entries are never re-read (the window suffix is part of
// the key), so without eviction a sustained store outage grows the map by
// one entry per (scope, identity) per window — unbounded under an
// unauthenticated flood. Sweep at most once per window to keep the cost of
// a request bounded while capping the map at roughly the active key set.
let nextMemorySweepAt = 0

const sweepExpiredMemoryCounters = (now: number, windowSeconds: number) => {
  if (now < nextMemorySweepAt) {
    return
  }
  nextMemorySweepAt = now + windowSeconds * 1000
  for (const [key, entry] of memoryCounters) {
    if (entry.expiresAt <= now) {
      memoryCounters.delete(key)
    }
  }
}

const incrementMemoryWindowCounter = (key: string, windowSeconds: number) => {
  const now = Date.now()
  sweepExpiredMemoryCounters(now, windowSeconds)
  const current = memoryCounters.get(key)
  if (!current || current.expiresAt <= now) {
    memoryCounters.set(key, {
      count: 1,
      expiresAt: now + windowSeconds * 1000,
    })
    return 1
  }

  const next = current.count + 1
  memoryCounters.set(key, { ...current, count: next })
  return next
}

/**
 * Upper bound on one store round trip. The cache connection's own
 * commandTimeout is 10 s, which is also Documenso's webhook delivery timeout
 * (and a timed-out delivery is terminal there): a HUNG Redis would hold every
 * limited request for the full 10 s. Past this bound the request takes the
 * same local fallback as a failed store. The abandoned INCR may still land
 * later; over-counting one window during an outage is the accepted cost.
 * Shared with the guest limiter.
 */
export const STORE_TIMEOUT_MS = 2000

/**
 * Keyed on the caller's authenticated identity (inbox id, workspace id, ...),
 * not the client IP — a per-token bearer credential is already that
 * identity, so this sidesteps the `x-forwarded-for` spoofing caveat that
 * IP-keyed limiters carry entirely.
 */
export const checkApiRateLimit = async ({
  scope,
  key: identityKey,
  limit = REQUEST_LIMIT,
  store = distributedStore,
  now = Date.now(),
  storeTimeoutMs = STORE_TIMEOUT_MS,
}: ApiRateLimitInput): Promise<ApiRateLimitResult> => {
  // Outside the try: a bad seam value is a caller bug, never a fallback.
  assertTimeoutMs(storeTimeoutMs)
  const windowSuffix = buildWindowSuffix(now, WINDOW_SECONDS)
  const retryAfter = secondsUntilNextWindow(now, WINDOW_SECONDS)
  const key = buildRateLimitKey(scope, identityKey, windowSuffix)

  try {
    const count = await withTimeout(
      store.incrWithWindow(key, WINDOW_SECONDS),
      storeTimeoutMs,
      "API rate limit store did not answer in time",
    )
    return { limited: count > limit, retryAfter }
  } catch (error) {
    logger.warn(
      { err: error, scope, key: identityKey },
      "API rate limit store failed, using local fallback",
    )
    const count = incrementMemoryWindowCounter(key, WINDOW_SECONDS)
    return { limited: count > limit, retryAfter }
  }
}

/**
 * Throwing wrapper around `checkApiRateLimit` shared by every bearer-token
 * API surface (channel API, workspace token API) so the 429 shape can never
 * drift between them.
 */
export const assertApiNotRateLimited = async (
  props: ApiRateLimitInput,
): Promise<void> => {
  const { limited, retryAfter } = await checkApiRateLimit(props)
  if (limited) {
    throw new ChatbotXException(
      `Too many requests. Retry after ${retryAfter}s.`,
      "tooManyRequests",
      TOO_MANY_REQUESTS_STATUS,
    )
  }
}
