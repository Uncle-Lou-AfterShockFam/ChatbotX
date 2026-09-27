/** One cap for the settings form and the frame-ancestors header (s210). */
export const MAX_AUTHORIZED_DOMAINS = 50

const PARENT_ORIGIN_PARAM = "parentOrigin"
const LEADING_DOTS_REGEX = /^\.+/
const TRAILING_DOTS_REGEX = /\.+$/
const PROTOCOL_PREFIX_REGEX = /^[a-z]+:\/\//i
const HOST_DELIMITER_REGEX = /[/:?#]/

const normalizeHost = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(LEADING_DOTS_REGEX, "")
    .replace(TRAILING_DOTS_REGEX, "")

export const getHostFromOrigin = (origin: string | null | undefined) => {
  if (!origin) {
    return null
  }

  const value = origin.trim()
  if (!value) {
    return null
  }

  try {
    return normalizeHost(new URL(value).hostname)
  } catch {
    const [host] = value
      .replace(PROTOCOL_PREFIX_REGEX, "")
      .split(HOST_DELIMITER_REGEX)
    return host ? normalizeHost(host) : null
  }
}

export const isOriginAuthorized = (
  origin: string | null | undefined,
  authorizedDomains: string[] = [],
) => {
  // No origin means the webchat was opened directly, not embedded in an
  // iframe — the allowlist only applies to embedding, so always allow.
  if (!origin) {
    return true
  }

  const domains = authorizedDomains.map(normalizeHost).filter(Boolean)
  if (domains.length === 0) {
    return false
  }

  const host = getHostFromOrigin(origin)
  if (!host) {
    return false
  }

  return domains.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  )
}

/**
 * A first-party open of the webchat: no embedding origin at all, or the hub's
 * own host (the builder's "Open webchat" preview). `appHost` is the proxy's
 * `x-domain`; an empty one never matches.
 */
export const isFirstPartyOrigin = (
  origin: string | null | undefined,
  appHost: string,
) => {
  if (!origin) {
    return true
  }
  const host = getHostFromOrigin(origin)
  return !!host && !!appHost && host === appHost.toLowerCase()
}

/**
 * The embed gate for guest calls, layered on the token check (owner s210): a
 * first-party origin always passes, and otherwise a non-empty allowlist must
 * match. An empty allowlist adds nothing here because the token binds the
 * origin and the `/webchat` page only mints one for a first-party open when
 * the list is empty.
 */
export const isGuestOriginAllowed = (
  origin: string | null | undefined,
  authorizedDomains: string[],
  appHost: string,
) =>
  authorizedDomains.length === 0 ||
  isFirstPartyOrigin(origin, appHost) ||
  isOriginAuthorized(origin, authorizedDomains)

export const getParentOriginFromUrl = (url: string | null | undefined) => {
  if (!url) {
    return null
  }

  try {
    return new URL(url).searchParams.get(PARENT_ORIGIN_PARAM)
  } catch {
    return null
  }
}
