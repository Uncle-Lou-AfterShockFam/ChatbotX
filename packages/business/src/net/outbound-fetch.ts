// Edge-safe (the barrel): the registry through which barrel code reaches the
// connection-pinned fetch that lives in the Node-only `./net-node` subpath.
// A Node process installs it once at startup (`installPinnedOutboundFetch`:
// builder instrumentation, worker bootstrap). Unregistered = FAIL CLOSED: a
// user-URL fetch refuses rather than fall back to an unpinned `fetch`.
// Keyed on globalThis because Next can load the barrel as more than one
// module instance in a process (instrumentation vs route bundles) (s216).

/** A body a redirect can safely replay (never a one-shot stream). */
export type OutboundBody = string | Uint8Array | URLSearchParams

export type OutboundRequestInit = {
  method?: string
  headers?: HeadersInit
  body?: OutboundBody | null
  signal?: AbortSignal | null
  /**
   * "follow" (default) follows at most 5 hops, each re-checked; "manual"
   * returns the 3xx as the answer; "error" throws on a 3xx.
   */
  redirect?: "follow" | "manual" | "error"
}

export type OutboundFetchOptions = {
  maxRedirects?: number
  /** One deadline for the whole redirect chain and the body read. */
  timeoutMs?: number
}

export type OutboundFetch = (
  input: string | URL,
  init?: OutboundRequestInit,
  options?: OutboundFetchOptions,
) => Promise<Response>

const REGISTRY_KEY = Symbol.for("chatbotx.outboundFetch")

type Registry = { [REGISTRY_KEY]?: OutboundFetch }

export class OutboundFetchNotInstalledError extends Error {
  constructor() {
    super(
      "[ssrf-guard] the pinned outbound fetch is not installed in this process",
    )
    this.name = "OutboundFetchNotInstalledError"
  }
}

export const registerOutboundFetch = (fetchImpl: OutboundFetch): void => {
  ;(globalThis as Registry)[REGISTRY_KEY] = fetchImpl
}

/**
 * `fetch` for a user- or workspace-supplied URL, pinned to the addresses the
 * SSRF guard validated at connect. Throws `SsrfFetchError` on a refusal and
 * `OutboundFetchNotInstalledError` when the process never installed it.
 */
export const outboundFetch: OutboundFetch = (input, init, options) => {
  const fetchImpl = (globalThis as Registry)[REGISTRY_KEY]
  if (!fetchImpl) {
    return Promise.reject(new OutboundFetchNotInstalledError())
  }
  return fetchImpl(input, init, options)
}

/** Deadline for downloading a user-supplied file (headers and body). */
export const DOWNLOAD_TIMEOUT_MS = 120_000

/** `uploadFileFromUrl`'s `fetchImpl`: a pinned GET with the download deadline. */
export const outboundDownload = (url: string): Promise<Response> =>
  outboundFetch(url, {}, { timeoutMs: DOWNLOAD_TIMEOUT_MS })
