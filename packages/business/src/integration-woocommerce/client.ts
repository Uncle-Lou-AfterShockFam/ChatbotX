import { readCapped } from "../documents/gotenberg"
import { isSsrfUnsafeUrl } from "../net/ssrf-guard"
import { pinnedFetch } from "../net-node/pinned-fetch"

/** One call to a site; a slow WordPress must not hold a flow step for long. */
export const SITE_REQUEST_TIMEOUT_MS = 20_000
/** An `order.invoice` answer is a few hundred bytes; anything bigger is not it. */
export const SITE_RESPONSE_MAX_BYTES = 64 * 1024

export type SiteAnswer = {
  status: number
  /** The JSON object the site answered, or null (not JSON, not an object). */
  body: Record<string, unknown> | null
}

/** A transport-level failure: no answer to interpret (retryable). */
export class SiteUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SiteUnreachableError"
  }
}

/**
 * The origin a site is stored under: https, no credentials, path, query or
 * fragment (a trailing `/` is fine). Null when the input is anything else.
 */
export function normalizeSiteUrl(value: string): string | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    return null
  }
  return url.origin
}

const PG_BIGINT_MAX = 9_223_372_036_854_775_807n
const DIGITS = /^[1-9]\d{0,18}$/

/** A positive id that fits a Postgres bigint (a longer one would 22003 the query). */
export const isPgBigintId = (value: unknown): value is string =>
  typeof value === "string" &&
  DIGITS.test(value) &&
  BigInt(value) <= PG_BIGINT_MAX

export const siteActionUrl = (siteUrl: string, action: string): string =>
  `${siteUrl}/wp-json/hub-connector/v1/actions/${action}`

/**
 * POST one hub-connector action to a linked site. The URL is re-checked
 * against the SSRF guard on every call (a site's DNS can change after
 * connect) and redirects are never followed: a 3xx is returned as the answer.
 * The fetch is pinned (net-node): the socket connects only to an address the
 * guard validated at connect, so a rebinding name cannot slip in (s216). This
 * subpath is Node-only already, so it imports the pinned fetch directly.
 */
export async function postSiteAction(props: {
  siteUrl: string
  token: string
  action: string
  body: unknown
  idempotencyKey?: string
}): Promise<SiteAnswer> {
  const url = siteActionUrl(props.siteUrl, props.action)
  if (await isSsrfUnsafeUrl(url)) {
    throw new SiteUnreachableError(
      `${props.siteUrl} resolves to an address the hub may not call`,
    )
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${props.token}`,
    "content-type": "application/json",
    accept: "application/json",
  }
  if (props.idempotencyKey) {
    headers["idempotency-key"] = props.idempotencyKey
  }
  let response: Response
  try {
    response = await pinnedFetch(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify(props.body),
        redirect: "manual",
      },
      { timeoutMs: SITE_REQUEST_TIMEOUT_MS },
    )
  } catch (error) {
    throw new SiteUnreachableError(
      `${props.siteUrl} did not answer: ${error instanceof Error ? error.message : "request failed"}`,
    )
  }
  let text: string | null
  try {
    const bytes = await readCapped(response, SITE_RESPONSE_MAX_BYTES)
    text = bytes === null ? null : Buffer.from(bytes).toString("utf8")
  } catch (error) {
    throw new SiteUnreachableError(
      `${props.siteUrl} answer could not be read: ${error instanceof Error ? error.message : "read failed"}`,
    )
  }
  let body: Record<string, unknown> | null = null
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text)
      body =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null
    } catch {
      body = null
    }
  }
  return { status: response.status, body }
}

/** The plugin's refusal code (`{ok:false, code}`), or "" when there is none. */
export const siteErrorCode = (answer: SiteAnswer): string =>
  typeof answer.body?.code === "string" ? answer.body.code : ""

export const siteErrorMessage = (answer: SiteAnswer): string => {
  const message =
    typeof answer.body?.message === "string" ? answer.body.message : ""
  const code = siteErrorCode(answer)
  return [`HTTP ${answer.status}`, code, message.slice(0, 300)]
    .filter(Boolean)
    .join(" ")
}
