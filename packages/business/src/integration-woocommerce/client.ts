import { isSsrfUnsafeUrl } from "../net/ssrf-guard"

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

export const siteActionUrl = (siteUrl: string, action: string): string =>
  `${siteUrl}/wp-json/hub-connector/v1/actions/${action}`

async function readCappedText(response: Response): Promise<string | null> {
  const reader = response.body?.getReader()
  if (!reader) {
    return ""
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    size += value.byteLength
    if (size > SITE_RESPONSE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * POST one hub-connector action to a linked site. The URL is re-checked
 * against the SSRF guard on every call (a site's DNS can change after
 * connect) and redirects are never followed: a 3xx is returned as the answer.
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
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(props.body),
      redirect: "manual",
      signal: AbortSignal.timeout(SITE_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new SiteUnreachableError(
      `${props.siteUrl} did not answer: ${error instanceof Error ? error.message : "request failed"}`,
    )
  }
  let text: string | null
  try {
    text = await readCappedText(response)
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
