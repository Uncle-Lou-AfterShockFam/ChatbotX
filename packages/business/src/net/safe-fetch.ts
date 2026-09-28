import { checkSsrfSafety } from "./ssrf-guard"

/** Hop cap for {@link fetchFollowingSafeRedirects} when a caller names none. */
export const DEFAULT_MAX_REDIRECTS = 5

export type SsrfFetchRefusal =
  | "unsafeUrl"
  | "unsafeAddress"
  | "unsafeRedirect"
  | "tooManyRedirects"

/** An outbound fetch the SSRF guard refused; `reason` says which check. */
export class SsrfFetchError extends Error {
  readonly reason: SsrfFetchRefusal

  constructor(reason: SsrfFetchRefusal, url: string) {
    super(`[ssrf-guard] ${reason}: ${url}`)
    this.name = "SsrfFetchError"
    this.reason = reason
  }
}

/**
 * `fetch` with `redirect: "manual"`, re-checking every hop's Location against
 * the SSRF guard before following it (a public URL that redirects to
 * 127.0.0.1 or 169.254.169.254 is the classic bypass of a check-once guard).
 * The caller has already checked `url` itself. Throws `SsrfFetchError` on an
 * unsafe or missing Location, or past `maxRedirects` hops.
 *
 * A narrow DNS-rebinding window remains between each check and fetch's own
 * resolution; see the note in external-request/service.ts.
 */
export const fetchFollowingSafeRedirects = async (
  url: string,
  init: RequestInit = {},
  maxRedirects = DEFAULT_MAX_REDIRECTS,
): Promise<Response> => {
  let current = url
  for (let hop = 0; ; hop += 1) {
    const response = await fetch(current, { ...init, redirect: "manual" })
    if (response.status < 300 || response.status >= 400) {
      return response
    }
    if (hop >= maxRedirects) {
      throw new SsrfFetchError("tooManyRedirects", current)
    }
    const location = response.headers.get("location")
    const next = location ? safeResolve(location, current) : null
    if (!next || (await checkSsrfSafety(next)).unsafe) {
      throw new SsrfFetchError("unsafeRedirect", location ?? current)
    }
    current = next
  }
}

const safeResolve = (location: string, base: string): string | null => {
  try {
    return new URL(location, base).href
  } catch {
    return null
  }
}
