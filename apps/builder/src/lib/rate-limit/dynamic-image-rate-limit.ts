import {
  checkFixedWindow,
  type FixedWindowResult,
  type FixedWindowStore,
  resetFixedWindowMemory,
  windowSuffix,
} from "./fixed-window"

/**
 * Dynamic-image re-render limiter (s219). A config with no cache field
 * re-renders on every valid-token hit (storage get, canvas, storage put), so
 * each (image, contact) pair gets 6 renders a minute. The token binds one
 * contact to one image, so a leaked link can only spin its own bucket; there
 * is no ip bucket (Meta / Gmail image proxies share addresses) and no
 * per-image ceiling (a broadcast renders once per contact).
 */
const WINDOW_SECONDS = 60
export const DYNAMIC_IMAGE_RENDER_LIMIT = 6

export type DynamicImageRenderLimitInput = {
  dynamicImageId: string
  contactId: string
  store?: FixedWindowStore
  now?: number
}

export class DynamicImageRenderLimitInputError extends Error {
  constructor() {
    super("dynamicImageId and contactId are required")
    this.name = "DynamicImageRenderLimitInputError"
  }
}

export const checkDynamicImageRenderLimit = (
  input: DynamicImageRenderLimitInput,
): Promise<FixedWindowResult> => {
  if (!(input?.dynamicImageId && input.contactId)) {
    throw new DynamicImageRenderLimitInputError()
  }
  const { dynamicImageId, contactId, store, now = Date.now() } = input
  const suffix = windowSuffix(now, WINDOW_SECONDS)
  return checkFixedWindow({
    buckets: [
      {
        key: ["dynamic-image-render", dynamicImageId, contactId, suffix].join(
          ":",
        ),
        limit: DYNAMIC_IMAGE_RENDER_LIMIT,
      },
    ],
    windowSeconds: WINDOW_SECONDS,
    store,
    now,
    scope: "dynamic-image-render",
    logContext: { dynamicImageId },
  })
}

/** Test seam: forget every in-memory window. */
export const resetDynamicImageRenderLimitMemory = resetFixedWindowMemory
