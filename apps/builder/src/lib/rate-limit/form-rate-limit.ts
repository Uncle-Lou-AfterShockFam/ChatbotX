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

/**
 * The start beacon (s224a A2-4) has its OWN budget, so a page that beacons
 * never eats its visitor's submit allowance. Two steps: the per-ip check
 * runs BEFORE any database lookup (an unknown slug still costs a query;
 * Codex probe s224a), the per-form one after the form resolved. A real page
 * sends one per load.
 */
const START_IP_LIMIT = 30
const START_FORM_LIMIT = 300
const startKey = (...parts: string[]) => ["form-start", ...parts].join(":")

export const checkFormStartIpRateLimit = ({
  clientIp,
  store,
  now = Date.now(),
}: Omit<FormRateLimitInput, "formId">): Promise<FormRateLimitResult> =>
  checkFixedWindow({
    buckets: [
      {
        key: startKey("ip", clientIp, windowSuffix(now, WINDOW_SECONDS)),
        limit: START_IP_LIMIT,
      },
    ],
    windowSeconds: WINDOW_SECONDS,
    store,
    now,
    scope: "form-start",
  })

export const checkFormStartFormRateLimit = ({
  formId,
  store,
  now = Date.now(),
}: Omit<FormRateLimitInput, "clientIp">): Promise<FormRateLimitResult> =>
  checkFixedWindow({
    buckets: [
      {
        key: startKey("form", formId, windowSuffix(now, WINDOW_SECONDS)),
        limit: START_FORM_LIMIT,
      },
    ],
    windowSeconds: WINDOW_SECONDS,
    store,
    now,
    scope: "form-start",
  })

/**
 * Web form uploads (s225a A2-4 PR 5): their own budget, ip first (before any
 * database lookup), then per form. Each call can carry 10 MiB, so the
 * budgets are small; the business layer also caps UNCLAIMED uploads per ip
 * and per form against stored rows.
 */
const UPLOAD_IP_LIMIT = 10
const UPLOAD_FORM_LIMIT = 100
const uploadKey = (...parts: string[]) => ["form-upload", ...parts].join(":")

export const checkFormUploadIpRateLimit = ({
  clientIp,
  store,
  now = Date.now(),
}: Omit<FormRateLimitInput, "formId">): Promise<FormRateLimitResult> =>
  checkFixedWindow({
    buckets: [
      {
        key: uploadKey("ip", clientIp, windowSuffix(now, WINDOW_SECONDS)),
        limit: UPLOAD_IP_LIMIT,
      },
    ],
    windowSeconds: WINDOW_SECONDS,
    store,
    now,
    scope: "form-upload",
  })

export const checkFormUploadFormRateLimit = ({
  formId,
  store,
  now = Date.now(),
}: Omit<FormRateLimitInput, "clientIp">): Promise<FormRateLimitResult> =>
  checkFixedWindow({
    buckets: [
      {
        key: uploadKey("form", formId, windowSuffix(now, WINDOW_SECONDS)),
        limit: UPLOAD_FORM_LIMIT,
      },
    ],
    windowSeconds: WINDOW_SECONDS,
    store,
    now,
    scope: "form-upload",
  })

/** Test seam: forget every in-memory window. */
export const resetFormRateLimitMemory = resetFixedWindowMemory
