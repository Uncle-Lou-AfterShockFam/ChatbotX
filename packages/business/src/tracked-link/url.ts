/**
 * URL shape of a tracked link. Kept free of database imports so pure text
 * rewriting (the chat worker, the API channel) can use it without pulling
 * the service, and so tests can import the real thing next to a mocked
 * `trackedLinkService`.
 */

/**
 * Path segment the public redirect route lives under
 * (`apps/builder/src/app/go/[token]`). Not `/l`: that prefix already holds the
 * QR landing page `/l/[workspaceId]/[id]`, and Next.js refuses two different
 * slug names at one path level (it crash-looped the builder, s165).
 */
export const TRACKED_LINK_PATH = "/go"
/** Suffix under a pixel token: `/go/<token>/o` answers a 1x1 GIF. */
export const TRACKED_PIXEL_SUFFIX = "/o"
/** Longest destination a text may carry; matches the flow step's text bound. */
export const MAX_TRACKED_LINK_URL_LENGTH = 2048

const TRAILING_SLASHES = /\/+$/

export const buildTrackedLinkUrl = (appUrl: string, token: string): string =>
  `${appUrl.replace(TRAILING_SLASHES, "")}${TRACKED_LINK_PATH}/${token}`

export const buildTrackedPixelUrl = (appUrl: string, token: string): string =>
  `${buildTrackedLinkUrl(appUrl, token)}${TRACKED_PIXEL_SUFFIX}`
