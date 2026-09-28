import { Agent, fetch as undiciFetch } from "undici"
import { SsrfFetchError } from "../net/safe-fetch"
import { isBlockedIp } from "../net/ssrf-guard"
import {
  guardedLookup,
  hostOf,
  isIpLiteral,
  type Resolver,
  systemResolver,
} from "./guarded-lookup"

// Node only (undici + node:dns). A fetch whose SSRF check is bound to the
// connection: undici's own fetch on an Agent whose `connect.lookup` refuses a
// blocked address, so the socket can only reach an address that was checked
// (no DoH-then-re-resolve window). Pooled sockets are safe: each one was
// validated when it connected. Never a global dispatcher: internal calls
// (storage, realtime, DoH) legitimately reach private and docker names.

const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_TIMEOUT_MS = 30_000
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const NULL_BODY_STATUSES = new Set([204, 205, 304])
// Dropped on a cross-origin hop, as the fetch spec does for Authorization.
const CROSS_ORIGIN_DROPPED = ["authorization", "cookie", "proxy-authorization"]
const BODY_HEADERS = [
  "content-type",
  "content-length",
  "content-encoding",
  "content-language",
  "content-location",
]

/** A body a redirect can safely replay (never a one-shot stream). */
export type PinnedBody = string | Uint8Array | URLSearchParams

export type PinnedRequestInit = {
  method?: string
  headers?: HeadersInit
  body?: PinnedBody | null
  signal?: AbortSignal | null
  /**
   * "follow" (default) follows at most `maxRedirects` hops, each re-checked;
   * "manual" returns the 3xx as the answer; "error" throws on a 3xx.
   */
  redirect?: "follow" | "manual" | "error"
}

/** `resolver` / `isBlocked` are test seams; production callers pass neither. */
export type PinnedFetchOptions = {
  resolver?: Resolver
  isBlocked?: (ip: string) => boolean
  maxRedirects?: number
  /** One deadline for the whole redirect chain, on top of `init.signal`. */
  timeoutMs?: number
}

const refuse = (hostname: string) =>
  new SsrfFetchError("unsafeAddress", hostname)

const defaultAgent = new Agent({
  connect: { lookup: guardedLookup(systemResolver, isBlockedIp, refuse) },
})

// Test seams get one Agent per (resolver, isBlocked) pair, reused across
// calls, so a seam never leaks a fresh socket pool per request.
const seamAgents = new WeakMap<object, WeakMap<object, Agent>>()

const agentFor = (options: PinnedFetchOptions): Agent => {
  if (!(options.resolver || options.isBlocked)) {
    return defaultAgent
  }
  const resolver = options.resolver ?? systemResolver
  const isBlocked = options.isBlocked ?? isBlockedIp
  const byBlocked = seamAgents.get(resolver) ?? new WeakMap<object, Agent>()
  seamAgents.set(resolver, byBlocked)
  const cached = byBlocked.get(isBlocked)
  if (cached) {
    return cached
  }
  const agent = new Agent({
    connect: { lookup: guardedLookup(resolver, isBlocked, refuse) },
  })
  byBlocked.set(isBlocked, agent)
  return agent
}

const parseUrl = (raw: string | URL): URL => {
  try {
    return new URL(raw)
  } catch {
    throw new SsrfFetchError("unsafeUrl", String(raw))
  }
}

/** undici wraps a connect failure as TypeError("fetch failed", { cause }). */
const unwrapRefusal = (error: unknown): unknown => {
  const cause = (error as { cause?: unknown } | null)?.cause
  return cause instanceof SsrfFetchError ? cause : error
}

/** Re-wraps undici's Response as the global one (callers and SDKs expect it). */
const toGlobalResponse = (
  response: Awaited<ReturnType<typeof undiciFetch>>,
  url: string,
): Response => {
  const wrapped = new Response(
    NULL_BODY_STATUSES.has(response.status)
      ? null
      : (response.body as ReadableStream<Uint8Array> | null),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers as unknown as HeadersInit,
    },
  )
  Object.defineProperty(wrapped, "url", { value: url })
  return wrapped
}

// undici's HeadersInit is its own Headers class; a plain record crosses over.
const toRecord = (headers: Headers): Record<string, string> => {
  const record: Record<string, string> = {}
  headers.forEach((value, name) => {
    record[name] = value
  })
  return record
}

const nextRequest = (
  status: number,
  method: string,
  headers: Headers,
  body: PinnedBody | null | undefined,
  from: URL,
  to: URL,
): { method: string; body: PinnedBody | null | undefined } => {
  if (from.origin !== to.origin) {
    for (const name of CROSS_ORIGIN_DROPPED) {
      headers.delete(name)
    }
  }
  const toGet =
    (status === 303 && method !== "HEAD") ||
    ((status === 301 || status === 302) && method === "POST")
  if (!toGet) {
    return { method, body }
  }
  for (const name of BODY_HEADERS) {
    headers.delete(name)
  }
  return { method: "GET", body: null }
}

/**
 * `fetch` for a user- or workspace-supplied URL. Every hop must be http(s);
 * an IP-literal host (which never reaches `lookup`) is checked directly; a
 * named host connects only to addresses the guarded lookup validated.
 * Redirects are followed by hand (re-checked, credentials dropped across
 * origins). Throws `SsrfFetchError` on any refusal; other network errors pass
 * through as undici throws them.
 */
export const pinnedFetch = async (
  input: string | URL,
  init: PinnedRequestInit = {},
  options: PinnedFetchOptions = {},
): Promise<Response> => {
  const isBlocked = options.isBlocked ?? isBlockedIp
  const dispatcher = agentFor(options)
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const deadline = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = init.signal
    ? AbortSignal.any([init.signal, deadline])
    : deadline
  const headers = new Headers(init.headers)
  // The Host is the URL's: a caller-set Host could steer a validated public
  // IP to an internal-only virtual host.
  headers.delete("host")
  let method = (init.method ?? "GET").toUpperCase()
  let body = init.body
  let url = parseUrl(input)

  for (let hop = 0; ; hop += 1) {
    const refusal = hop === 0 ? "unsafeUrl" : "unsafeRedirect"
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new SsrfFetchError(refusal, url.href)
    }
    const host = hostOf(url)
    if (isIpLiteral(host) && isBlocked(host)) {
      throw new SsrfFetchError(refusal, url.href)
    }

    let response: Awaited<ReturnType<typeof undiciFetch>>
    try {
      response = await undiciFetch(url, {
        method,
        headers: toRecord(headers),
        body: body ?? null,
        signal,
        redirect: "manual",
        dispatcher,
      })
    } catch (error) {
      throw unwrapRefusal(error)
    }

    if (!REDIRECT_STATUSES.has(response.status) || init.redirect === "manual") {
      return toGlobalResponse(response, url.href)
    }
    await response.body?.cancel()
    if (init.redirect === "error") {
      throw new SsrfFetchError("unsafeRedirect", url.href)
    }
    if (hop >= maxRedirects) {
      throw new SsrfFetchError("tooManyRedirects", url.href)
    }
    const location = response.headers.get("location")
    if (!location) {
      throw new SsrfFetchError("unsafeRedirect", url.href)
    }
    let next: URL
    try {
      next = new URL(location, url)
    } catch {
      throw new SsrfFetchError("unsafeRedirect", location)
    }
    ;({ method, body } = nextRequest(
      response.status,
      method,
      headers,
      body,
      url,
      next,
    ))
    url = next
  }
}
