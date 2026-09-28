// Edge-safe: the registry through which any package reaches the
// connection-pinned fetch that lives in business's Node-only `./net-node`
// subpath. A Node process installs it once at startup
// (`installPinnedOutboundFetch`: builder instrumentation, worker bootstrap).
// Unregistered = FAIL CLOSED: a user-URL fetch refuses rather than fall back
// to an unpinned `fetch`. Keyed on globalThis because Next can load a module
// as more than one instance in a process (instrumentation vs route bundles)
// and the worker bundle duplicates modules (s216). Lives in the sdk (s219) so
// the integration packages, which never depend on business, reach the same
// registry; business re-exports every name.

// The sdk compiles without the DOM lib: name the fetch types through the
// runtime globals @types/node declares.
type HeadersInit = ConstructorParameters<typeof Headers>[0]
type RequestRedirect = Request["redirect"]

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

export type SsrfFetchRefusal =
  | "unsafeUrl"
  | "unsafeAddress"
  | "unsafeRedirect"
  | "tooManyRedirects"

/**
 * An outbound fetch the SSRF guard refused; `reason` says which check. Thrown
 * by the pinned fetch (business `./net-node`, reached through `outboundFetch`).
 * The check-then-fetch `fetchFollowingSafeRedirects` was retired in s216: it
 * left a DNS-rebinding window between its check and fetch.
 */
export class SsrfFetchError extends Error {
  readonly reason: SsrfFetchRefusal

  constructor(reason: SsrfFetchRefusal, url: string) {
    super(`[ssrf-guard] ${reason}: ${url}`)
    this.name = "SsrfFetchError"
    this.reason = reason
  }
}

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
export const outboundDownload = (
  url: string,
  init?: Pick<OutboundRequestInit, "headers">,
): Promise<Response> =>
  outboundFetch(url, init ?? {}, { timeoutMs: DOWNLOAD_TIMEOUT_MS })

const BODYLESS_METHODS = new Set(["GET", "HEAD"])

const toOutboundRedirect = (
  redirect: RequestRedirect,
): OutboundRequestInit["redirect"] =>
  redirect === "manual" || redirect === "error" ? redirect : "follow"

/**
 * ky's `fetch` option, routed through `outboundFetch`: a ky client whose
 * base URL a workspace supplies reaches only public addresses. ky hands its
 * `fetch` a `Request`; the body is buffered (ky bodies are small JSON / form
 * payloads) because the pinned fetch replays it on a redirect.
 */
export const kyOutboundFetch = async (
  input: Request | string | URL,
  init?: RequestInit,
): Promise<Response> => {
  if (typeof input === "string" || input instanceof URL) {
    return outboundFetch(input, {
      method: init?.method,
      headers: init?.headers,
      signal: init?.signal,
    })
  }
  if (!(input instanceof Request)) {
    throw new TypeError("[ssrf-guard] kyOutboundFetch needs a Request or URL")
  }
  const method = input.method.toUpperCase()
  const body = BODYLESS_METHODS.has(method)
    ? null
    : new Uint8Array(await input.arrayBuffer())
  return outboundFetch(input.url, {
    method,
    headers: input.headers,
    body: body && body.byteLength > 0 ? body : null,
    signal: init?.signal ?? input.signal,
    redirect: toOutboundRedirect(input.redirect),
  })
}

/** Anything with a body stream: a fetch Response or an incoming Request. */
type BodySource = Pick<Response, "body" | "arrayBuffer">

/**
 * Reads a body up to `max` bytes; `null` means it was larger (the stream is
 * cancelled at the first chunk past the cap, never buffered whole).
 */
export const readCapped = async (
  res: BodySource,
  max: number,
): Promise<Uint8Array | null> => {
  const reader = res.body?.getReader()
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer())
    return buf.length > max ? null : buf
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    total += value.length
    if (total > max) {
      // Over the cap: stop reading; the answer is already too-large.
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
