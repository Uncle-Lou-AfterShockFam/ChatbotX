import {
  checkFixedWindow,
  type FixedWindowResult,
  type FixedWindowStore,
  resetFixedWindowMemory,
  windowSuffix,
} from "./fixed-window"

/**
 * Email-template preview limiter (s221b). The editor re-renders its draft
 * (MJML + sanitizer + tenant settings) after each debounced change, so one
 * user gets 60 renders a minute: a steady typist at the 700 ms debounce stays
 * under it, a runaway client does not.
 */
const WINDOW_SECONDS = 60
export const EMAIL_PREVIEW_LIMIT = 60

export class EmailPreviewRateLimitInputError extends Error {
  constructor() {
    super("userId is required")
    this.name = "EmailPreviewRateLimitInputError"
  }
}

export const checkEmailPreviewRateLimit = (input: {
  userId: string
  store?: FixedWindowStore
  now?: number
}): Promise<FixedWindowResult> => {
  if (!input?.userId) {
    throw new EmailPreviewRateLimitInputError()
  }
  const { userId, store, now = Date.now() } = input
  return checkFixedWindow({
    buckets: [
      {
        key: ["email-preview", userId, windowSuffix(now, WINDOW_SECONDS)].join(
          ":",
        ),
        limit: EMAIL_PREVIEW_LIMIT,
      },
    ],
    windowSeconds: WINDOW_SECONDS,
    store,
    now,
    scope: "email-preview",
    logContext: { userId },
  })
}

/** Test seam: forget every in-memory window. */
export const resetEmailPreviewRateLimitMemory = resetFixedWindowMemory
