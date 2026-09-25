import { distributedStore } from "@chatbotx.io/redis"
import { logger } from "@/lib/log"

/**
 * One fixed-window counter shared by the public limiters (s200): the window
 * index is folded into the key, so a steady sender cannot keep a bucket
 * alive by refreshing a TTL; the store failing falls back to a process-local
 * map so a Redis outage degrades to per-instance limiting, never to none.
 */
export type FixedWindowStore = Pick<
  typeof distributedStore,
  "incrementCounter" | "setNumberIfNotExists"
>

export type FixedWindowBucket = { key: string; limit: number }

export type FixedWindowResult = { limited: boolean; retryAfter: number }

const memoryCounters = new Map<string, { count: number; expiresAt: number }>()

export const windowSuffix = (now: number, windowSeconds: number) =>
  String(Math.floor(now / (windowSeconds * 1000)))

export const secondsUntilNextWindow = (now: number, windowSeconds: number) => {
  const windowMs = windowSeconds * 1000
  return Math.ceil((windowMs - (now % windowMs)) / 1000)
}

const incrementMemory = (key: string, now: number, windowSeconds: number) => {
  const current = memoryCounters.get(key)
  if (!current || current.expiresAt <= now) {
    memoryCounters.set(key, { count: 1, expiresAt: now + windowSeconds * 1000 })
    return 1
  }
  current.count += 1
  return current.count
}

const incrementStore = async (
  store: FixedWindowStore,
  key: string,
  windowSeconds: number,
) => {
  const created = await store.setNumberIfNotExists(key, 1, windowSeconds)
  if (created) {
    return 1
  }
  return (await store.incrementCounter(key, 1, windowSeconds)) ?? 1
}

/**
 * Count one hit against every bucket in order; the first bucket over its
 * limit answers `limited` with the seconds left in the window.
 */
export async function checkFixedWindow(props: {
  buckets: FixedWindowBucket[]
  windowSeconds: number
  store?: FixedWindowStore
  now?: number
  /** Names the caller in the fallback log line. */
  scope: string
}): Promise<FixedWindowResult> {
  const {
    buckets,
    windowSeconds,
    store = distributedStore,
    now = Date.now(),
    scope,
  } = props
  const retryAfter = secondsUntilNextWindow(now, windowSeconds)
  try {
    for (const bucket of buckets) {
      if (
        (await incrementStore(store, bucket.key, windowSeconds)) > bucket.limit
      ) {
        return { limited: true, retryAfter }
      }
    }
    return { limited: false, retryAfter }
  } catch (error) {
    logger.warn(
      { err: error, scope },
      "Rate limit store failed, using local fallback",
    )
    for (const bucket of buckets) {
      if (incrementMemory(bucket.key, now, windowSeconds) > bucket.limit) {
        return { limited: true, retryAfter }
      }
    }
    return { limited: false, retryAfter }
  }
}

/** Test seam: forget every in-memory window. */
export const resetFixedWindowMemory = () => memoryCounters.clear()
