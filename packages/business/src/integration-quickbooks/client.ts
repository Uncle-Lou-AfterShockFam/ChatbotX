import type {
  QuickbooksCredential,
  QuickbooksEnvironment,
} from "@chatbotx.io/database/partials"
import { readCapped } from "../documents/gotenberg"

/**
 * QuickBooks Online over plain fetch (s214b). Every host is Intuit's, fixed
 * here: no caller-supplied URL reaches fetch, so no SSRF guard is needed.
 * Intuit docs: developer.intuit.com/app/developer/qbo/docs.
 */
export const QUICKBOOKS_AUTHORIZE_URL =
  "https://appcenter.intuit.com/connect/oauth2"
export const QUICKBOOKS_TOKEN_URL =
  "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
export const QUICKBOOKS_REVOKE_URL =
  "https://developer.api.intuit.com/v2/oauth2/tokens/revoke"
/** Accounting to book invoices; payment so QBO Payments can take the card. */
export const QUICKBOOKS_SCOPES = [
  "com.intuit.quickbooks.accounting",
  "com.intuit.quickbooks.payment",
] as const
/** Pinned so a server-side default change never reshapes an answer. */
export const QUICKBOOKS_MINOR_VERSION = "75"

const API_HOSTS: Record<QuickbooksEnvironment, string> = {
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
  production: "https://quickbooks.api.intuit.com",
}

export const QUICKBOOKS_REQUEST_TIMEOUT_MS = 20_000
/** A page of 100 invoices with lines is well under this; a CDC page too. */
export const QUICKBOOKS_RESPONSE_MAX_BYTES = 4 * 1024 * 1024
/** Intuit answers a missing / stale SyncToken with this Fault code. */
export const QUICKBOOKS_STALE_OBJECT_CODE = "5010"

/**
 * A failed QuickBooks call. `retryable`: a network failure, a 429 or a 5xx
 * (a job may try again); `authRejected`: the access token was refused (one
 * forced refresh may fix it); anything else is the request's own fault.
 */
export class QuickbooksApiError extends Error {
  readonly status: number
  readonly retryable: boolean
  readonly authRejected: boolean
  readonly code: string
  readonly retryAfterSeconds: number | null

  constructor(
    message: string,
    props: {
      status: number
      retryable: boolean
      authRejected?: boolean
      code?: string
      retryAfterSeconds?: number | null
    },
  ) {
    super(message)
    this.name = "QuickbooksApiError"
    this.status = props.status
    this.retryable = props.retryable
    this.authRejected = props.authRejected ?? false
    this.code = props.code ?? ""
    this.retryAfterSeconds = props.retryAfterSeconds ?? null
  }
}

/** Intuit refused the refresh token (revoked, expired): only a reconnect helps. */
export class QuickbooksReconnectRequiredError extends Error {
  constructor(message = "QuickBooks needs to be reconnected") {
    super(message)
    this.name = "QuickbooksReconnectRequiredError"
  }
}

export type QuickbooksTokenSet = {
  accessToken: string
  /** Epoch ms. */
  accessExpiresAt: number
  refreshToken: string
  /** Epoch ms. */
  refreshExpiresAt: number
}

type OAuthClient = Pick<QuickbooksCredential, "clientId" | "clientSecret">

export function buildQuickbooksAuthorizeUrl(props: {
  clientId: string
  redirectUri: string
  state: string
}): string {
  const url = new URL(QUICKBOOKS_AUTHORIZE_URL)
  url.searchParams.set("client_id", props.clientId)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("scope", QUICKBOOKS_SCOPES.join(" "))
  url.searchParams.set("redirect_uri", props.redirectUri)
  url.searchParams.set("state", props.state)
  return url.toString()
}

const retryAfterOf = (response: Response): number | null => {
  const value = Number(response.headers.get("retry-after"))
  return Number.isFinite(value) && value > 0 ? Math.min(value, 3600) : null
}

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(QUICKBOOKS_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new QuickbooksApiError(
      `QuickBooks did not answer: ${error instanceof Error ? error.message : "request failed"}`,
      { status: 0, retryable: true },
    )
  }
}

/** The JSON object answered, or null (empty, too large, not JSON, not an object). */
async function readJsonObject(
  response: Response,
): Promise<Record<string, unknown> | null> {
  let bytes: Uint8Array | null
  try {
    bytes = await readCapped(response, QUICKBOOKS_RESPONSE_MAX_BYTES)
  } catch {
    return null
  }
  if (!bytes || bytes.length === 0) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

const basicAuth = (client: OAuthClient) =>
  `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`

const positiveSeconds = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback

async function tokenRequest(
  client: OAuthClient,
  form: Record<string, string>,
): Promise<QuickbooksTokenSet> {
  const response = await send(QUICKBOOKS_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: basicAuth(client),
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
  })
  const body = await readJsonObject(response)
  if (response.status === 400 && body?.error === "invalid_grant") {
    throw new QuickbooksReconnectRequiredError(
      "QuickBooks refused the saved authorization: reconnect QuickBooks",
    )
  }
  if (!response.ok) {
    throw new QuickbooksApiError(
      `QuickBooks token request failed: HTTP ${response.status} ${typeof body?.error === "string" ? body.error : ""}`.trim(),
      {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
        retryAfterSeconds: retryAfterOf(response),
      },
    )
  }
  if (
    typeof body?.access_token !== "string" ||
    typeof body.refresh_token !== "string" ||
    body.access_token.length === 0 ||
    body.refresh_token.length === 0
  ) {
    throw new QuickbooksApiError("QuickBooks answered no tokens", {
      status: response.status,
      retryable: true,
    })
  }
  const now = Date.now()
  return {
    accessToken: body.access_token,
    accessExpiresAt: now + positiveSeconds(body.expires_in, 3600) * 1000,
    refreshToken: body.refresh_token,
    refreshExpiresAt:
      now +
      positiveSeconds(body.x_refresh_token_expires_in, 100 * 86_400) * 1000,
  }
}

export const exchangeQuickbooksCode = (props: {
  client: OAuthClient
  code: string
  redirectUri: string
}): Promise<QuickbooksTokenSet> =>
  tokenRequest(props.client, {
    grant_type: "authorization_code",
    code: props.code,
    redirect_uri: props.redirectUri,
  })

/**
 * A new token pair. Intuit may rotate the refresh token on any refresh: the
 * caller must persist the one this returns, never keep the old one.
 */
export const refreshQuickbooksTokens = (props: {
  client: OAuthClient
  refreshToken: string
}): Promise<QuickbooksTokenSet> =>
  tokenRequest(props.client, {
    grant_type: "refresh_token",
    refresh_token: props.refreshToken,
  })

/** Best effort: a disconnect must not fail because Intuit did not answer. */
export async function revokeQuickbooksToken(props: {
  client: OAuthClient
  token: string
}): Promise<boolean> {
  try {
    const response = await send(QUICKBOOKS_REVOKE_URL, {
      method: "POST",
      headers: {
        authorization: basicAuth(props.client),
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ token: props.token }),
    })
    return response.ok
  } catch {
    return false
  }
}

/** Fault.Error[0] of an Intuit error answer, as `code: Message (Detail)`. */
export function quickbooksFault(body: Record<string, unknown> | null): {
  code: string
  message: string
} {
  const fault = body?.Fault as { Error?: unknown } | undefined
  const first = Array.isArray(fault?.Error)
    ? (fault.Error[0] as Record<string, unknown> | undefined)
    : undefined
  const code = typeof first?.code === "string" ? first.code : ""
  const message = [
    typeof first?.Message === "string" ? first.Message : "",
    typeof first?.Detail === "string" ? `(${first.Detail})` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 400)
  return { code, message }
}

export type QuickbooksRequest = {
  environment: QuickbooksEnvironment
  realmId: string
  accessToken: string
  method: "GET" | "POST"
  /** Under /v3/company/<realm>/, e.g. `invoice` or `query`. */
  path: string
  query?: Record<string, string>
  body?: unknown
  /**
   * Intuit's idempotency key for a write: a replay with the same id answers
   * the first result instead of creating a second object.
   */
  requestId?: string
}

const REALM = /^\d{1,32}$/
const PATH = /^[a-z]+(?:\/[A-Za-z0-9]+){0,2}$/
const REQUEST_ID = /^[A-Za-z0-9-]{1,50}$/

/** One QuickBooks API call; the parsed answer, or a QuickbooksApiError. */
export async function quickbooksRequest(
  request: QuickbooksRequest,
): Promise<Record<string, unknown>> {
  if (!REALM.test(request.realmId)) {
    throw new QuickbooksApiError("Invalid QuickBooks company id", {
      status: 0,
      retryable: false,
    })
  }
  if (!PATH.test(request.path)) {
    throw new QuickbooksApiError("Invalid QuickBooks API path", {
      status: 0,
      retryable: false,
    })
  }
  if (request.requestId !== undefined && !REQUEST_ID.test(request.requestId)) {
    throw new QuickbooksApiError("Invalid QuickBooks request id", {
      status: 0,
      retryable: false,
    })
  }
  const url = new URL(
    `/v3/company/${request.realmId}/${request.path}`,
    API_HOSTS[request.environment],
  )
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, value)
  }
  url.searchParams.set("minorversion", QUICKBOOKS_MINOR_VERSION)
  if (request.requestId) {
    url.searchParams.set("requestid", request.requestId)
  }
  const response = await send(url.toString(), {
    method: request.method,
    headers: {
      authorization: `Bearer ${request.accessToken}`,
      accept: "application/json",
      ...(request.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  })
  const body = await readJsonObject(response)
  if (response.ok && body && !body.Fault) {
    return body
  }
  const fault = quickbooksFault(body)
  const status = response.status
  throw new QuickbooksApiError(
    `QuickBooks ${request.method} ${request.path} failed: HTTP ${status}${fault.code ? ` ${fault.code}` : ""}${fault.message ? ` ${fault.message}` : ""}`,
    {
      status,
      retryable: status === 0 || status === 429 || status >= 500 || !body,
      authRejected: status === 401,
      code: fault.code,
      retryAfterSeconds: retryAfterOf(response),
    },
  )
}

/**
 * A QuickBooks query string literal. Intuit's query language escapes a quote
 * with a backslash; anything outside printable text is refused rather than
 * escaped, so no caller value can end the literal.
 */
const isUnsafeQueryChar = (char: string) =>
  char === "\\" || (char.codePointAt(0) ?? 0) < 0x20

export function quickbooksQueryLiteral(value: string): string {
  if (value.length > 200 || [...value].some(isUnsafeQueryChar)) {
    throw new QuickbooksApiError("Value not allowed in a QuickBooks query", {
      status: 0,
      retryable: false,
    })
  }
  return `'${value.replaceAll("'", "\\'")}'`
}
