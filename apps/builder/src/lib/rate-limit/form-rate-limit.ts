import { distributedStore } from "@chatbotx.io/redis"
import { logger } from "@/lib/log"

/**
 * Public form submit limiter (s200): fixed windows per visitor ip and per
 * form, keyed like `guest-rate-limit` (the window index is folded into the
 * key, so a steady sender cannot keep a bucket alive). The per-form,
 * per-visitor HOURLY budget from the form's settings is enforced in the
 * business layer against stored rows; this is the cheap first line.
 */
const WINDOW_SECONDS = 60
const IP_LIMIT = 60
const FORM_LIMIT = 600
const memoryCounters = new Map<string, { count: number; expiresAt: number }>()

type RateLimitStore = Pick<
  typeof distributedStore,
  "incrementCounter" | "setNumberIfNotExists"
>

export type FormRateLimitInput = {
  formId: string
  clientIp: string
  store?: RateLimitStore
  now?: number
}

export type FormRateLimitResult = { limited: boolean; retryAfter: number }

const key = (...parts: string[]) => ["form-rate-limit", ...parts].join(":")
const windowSuffix = (now: number) =>
  String(Math.floor(now / (WINDOW_SECONDS * 1000)))
const secondsUntilNextWindow = (now: number) => {
  const windowMs = WINDOW_SECONDS * 1000
  return Math.ceil((windowMs - (now % windowMs)) / 1000)
}

const incrementMemory = (k: string, now: number) => {
  const current = memoryCounters.get(k)
  if (!current || current.expiresAt <= now) {
    memoryCounters.set(k, { count: 1, expiresAt: now + WINDOW_SECONDS * 1000 })
    return 1
  }
  current.count += 1
  return current.count
}

const incrementStore = async (store: RateLimitStore, k: string) => {
  const created = await store.setNumberIfNotExists(k, 1, WINDOW_SECONDS)
  if (created) {
    return 1
  }
  return (await store.incrementCounter(k, 1, WINDOW_SECONDS)) ?? 1
}

export const checkFormRateLimit = async ({
  formId,
  clientIp,
  store = distributedStore,
  now = Date.now(),
}: FormRateLimitInput): Promise<FormRateLimitResult> => {
  const suffix = windowSuffix(now)
  const retryAfter = secondsUntilNextWindow(now)
  const ipKey = key("ip", clientIp, suffix)
  const formKey = key("form", formId, suffix)
  try {
    if ((await incrementStore(store, ipKey)) > IP_LIMIT) {
      return { limited: true, retryAfter }
    }
    if ((await incrementStore(store, formKey)) > FORM_LIMIT) {
      return { limited: true, retryAfter }
    }
    return { limited: false, retryAfter }
  } catch (error) {
    logger.warn(
      { err: error, formId, clientIp },
      "Form rate limit store failed, using local fallback",
    )
    if (incrementMemory(ipKey, now) > IP_LIMIT) {
      return { limited: true, retryAfter }
    }
    if (incrementMemory(formKey, now) > FORM_LIMIT) {
      return { limited: true, retryAfter }
    }
    return { limited: false, retryAfter }
  }
}

/** Test seam: forget every in-memory window. */
export const resetFormRateLimitMemory = () => memoryCounters.clear()
