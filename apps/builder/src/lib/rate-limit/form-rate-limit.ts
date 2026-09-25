import {
  checkFixedWindow,
  type FixedWindowResult,
  type FixedWindowStore,
  resetFixedWindowMemory,
  windowSuffix,
} from "./fixed-window"

/**
 * Public form submit limiter (s200): 60 / min per visitor ip and 600 / min
 * per form, on the shared fixed-window counter. The per-form, per-visitor
 * HOURLY budget from the form's settings is enforced in the business layer
 * against stored rows; this is the cheap first line.
 */
const WINDOW_SECONDS = 60
const IP_LIMIT = 60
const FORM_LIMIT = 600

export type FormRateLimitInput = {
  formId: string
  clientIp: string
  store?: FixedWindowStore
  now?: number
}

export type FormRateLimitResult = FixedWindowResult

const key = (...parts: string[]) => ["form-rate-limit", ...parts].join(":")

export const checkFormRateLimit = ({
  formId,
  clientIp,
  store,
  now = Date.now(),
}: FormRateLimitInput): Promise<FormRateLimitResult> => {
  const suffix = windowSuffix(now, WINDOW_SECONDS)
  return checkFixedWindow({
    buckets: [
      { key: key("ip", clientIp, suffix), limit: IP_LIMIT },
      { key: key("form", formId, suffix), limit: FORM_LIMIT },
    ],
    windowSeconds: WINDOW_SECONDS,
    store,
    now,
    scope: "form-submit",
  })
}

/** Test seam: forget every in-memory window. */
export const resetFormRateLimitMemory = resetFixedWindowMemory
