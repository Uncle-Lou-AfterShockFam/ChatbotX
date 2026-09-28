export type SsrfFetchRefusal =
  | "unsafeUrl"
  | "unsafeAddress"
  | "unsafeRedirect"
  | "tooManyRedirects"

/**
 * An outbound fetch the SSRF guard refused; `reason` says which check. Thrown
 * by the pinned fetch (`./net-node`, reached through `outboundFetch`). The
 * check-then-fetch `fetchFollowingSafeRedirects` that lived here was retired
 * in s216: it left a DNS-rebinding window between its check and fetch.
 */
export class SsrfFetchError extends Error {
  readonly reason: SsrfFetchRefusal

  constructor(reason: SsrfFetchRefusal, url: string) {
    super(`[ssrf-guard] ${reason}: ${url}`)
    this.name = "SsrfFetchError"
    this.reason = reason
  }
}
