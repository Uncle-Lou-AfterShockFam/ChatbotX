import "server-only"

import {
  isSsrfFetchError,
  outboundFetch,
} from "@chatbotx.io/sdk/outbound-fetch"

/**
 * The `fetch` handed to the MCP SDK transport on validate (s233a): the URL is
 * member-typed, so every request goes through the connection-pinned outbound
 * fetch (private / internal addresses refused at connect). The transport
 * calls it with a string URL and a string (or no) body; anything else is
 * refused rather than sent unpinned. Redirects are always refused, the SDK's
 * own default.
 */
export const pinnedMcpFetch: typeof fetch = (input, init) => {
  if (!(typeof input === "string" || input instanceof URL)) {
    return Promise.reject(new TypeError("pinnedMcpFetch: URL input only"))
  }
  const body = init?.body
  if (!(body === undefined || body === null || typeof body === "string")) {
    return Promise.reject(new TypeError("pinnedMcpFetch: string body only"))
  }
  return outboundFetch(input, {
    method: init?.method,
    headers: init?.headers as ConstructorParameters<typeof Headers>[0],
    body,
    signal: init?.signal,
    redirect: "error",
  })
}

const MAX_CAUSE_DEPTH = 5

/** The SDK wraps transport failures; look a few `cause` links down. */
export const isSsrfRefusal = (error: unknown): boolean => {
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth += 1) {
    if (isSsrfFetchError(current)) {
      return true
    }
    current = (current as { cause?: unknown }).cause
  }
  return false
}
