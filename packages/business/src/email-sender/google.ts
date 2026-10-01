import { readCapped } from "@chatbotx.io/sdk/outbound-fetch"

/**
 * Google OAuth for Gmail / Workspace mailbox senders (s230b) over plain
 * fetch. Every host is Google's, fixed here: no caller-supplied URL reaches
 * fetch. The refresh token never leaves the hub; the line gets short-lived
 * access tokens through its credential feed.
 */
export const GOOGLE_AUTHORIZE_URL =
  "https://accounts.google.com/o/oauth2/v2/auth"
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
/** Full IMAP + SMTP (XOAUTH2) needs the restricted `mail.google.com` scope. */
export const GMAIL_SCOPE = "https://mail.google.com/"
export const GMAIL_SENDER_SCOPES = [
  GMAIL_SCOPE,
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
] as const
const ID_TOKEN_ISSUERS = ["https://accounts.google.com", "accounts.google.com"]
/** Google's closed error code (the description is never kept). */
const ERROR_CODE = /^[a-z_]{1,64}$/
/** A bearer token: printable ASCII, no space. */
const TOKEN_CHARS = /^[\x21-\x7e]+$/

export const GOOGLE_REQUEST_TIMEOUT_MS = 15_000
const RESPONSE_MAX_BYTES = 64 * 1024
/** The line refuses a longer access token (its feed parser's cap). */
export const GOOGLE_ACCESS_TOKEN_MAX = 2048

/** A Google token call failed; `retryable` for a network error / 429 / 5xx. */
export class GoogleOAuthError extends Error {
  readonly status: number
  readonly retryable: boolean
  constructor(message: string, props: { status: number; retryable: boolean }) {
    super(message)
    this.name = "GoogleOAuthError"
    this.status = props.status
    this.retryable = props.retryable
  }
}

/** Google refused the refresh token (revoked, expired): only a reconnect helps. */
export class GoogleReconnectRequiredError extends Error {
  constructor(message = "Google refused the saved authorization") {
    super(message)
    this.name = "GoogleReconnectRequiredError"
  }
}

export type GoogleOAuthClient = { clientId: string; clientSecret: string }

export type GoogleAccessToken = {
  accessToken: string
  /** Epoch ms. */
  expiresAt: number
}

export type GoogleSenderGrant = GoogleAccessToken & {
  refreshToken: string
  scope: string
  /** The verified address of the Google account that consented. */
  email: string
}

export function buildGoogleSenderAuthorizeUrl(props: {
  clientId: string
  redirectUri: string
  state: string
  loginHint?: string
}): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL)
  url.searchParams.set("client_id", props.clientId)
  url.searchParams.set("redirect_uri", props.redirectUri)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("scope", GMAIL_SENDER_SCOPES.join(" "))
  // offline + consent: Google returns a refresh token on EVERY connect.
  url.searchParams.set("access_type", "offline")
  url.searchParams.set("prompt", "consent")
  url.searchParams.set("include_granted_scopes", "false")
  url.searchParams.set("state", props.state)
  if (props.loginHint) {
    url.searchParams.set("login_hint", props.loginHint)
  }
  return url.toString()
}

async function tokenCall(
  form: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  let response: Response
  try {
    response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new GoogleOAuthError(
      `Google did not answer: ${error instanceof Error ? error.message : "request failed"}`,
      { status: 0, retryable: true },
    )
  }
  let body: Record<string, unknown> | null = null
  try {
    const bytes = await readCapped(response, RESPONSE_MAX_BYTES)
    const parsed: unknown = bytes?.length
      ? JSON.parse(Buffer.from(bytes).toString("utf8"))
      : null
    body =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
  } catch {
    body = null
  }
  if (response.status === 400 && body?.error === "invalid_grant") {
    throw new GoogleReconnectRequiredError()
  }
  if (!response.ok) {
    // Only Google's closed error code is kept (never the description).
    const code =
      typeof body?.error === "string" && ERROR_CODE.test(body.error)
        ? body.error
        : ""
    throw new GoogleOAuthError(
      `Google token request failed: HTTP ${response.status} ${code}`.trim(),
      {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      },
    )
  }
  return { status: response.status, body }
}

function accessTokenOf(
  body: Record<string, unknown> | null,
  status: number,
): GoogleAccessToken {
  const token = body?.access_token
  const expiresIn = body?.expires_in
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > GOOGLE_ACCESS_TOKEN_MAX ||
    !TOKEN_CHARS.test(token)
  ) {
    throw new GoogleOAuthError("Google answered no usable access token", {
      status,
      retryable: true,
    })
  }
  const seconds =
    typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? Math.min(expiresIn, 24 * 3600)
      : 3600
  return { accessToken: token, expiresAt: Date.now() + seconds * 1000 }
}

/**
 * The claims of an id_token received DIRECTLY from Google's token endpoint
 * over TLS with our client secret: Google documents that such a token need
 * not have its signature checked; its audience and issuer still are.
 */
function idTokenEmail(idToken: unknown, clientId: string): string | null {
  if (typeof idToken !== "string" || idToken.length > 8192) {
    return null
  }
  const [, payload] = idToken.split(".")
  if (!payload) {
    return null
  }
  let claims: Record<string, unknown>
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    return null
  }
  if (
    !claims ||
    claims.aud !== clientId ||
    !ID_TOKEN_ISSUERS.includes(String(claims.iss)) ||
    claims.email_verified !== true ||
    typeof claims.email !== "string"
  ) {
    return null
  }
  return claims.email.trim().toLowerCase()
}

/**
 * Exchanges a connect's code. Throws GoogleOAuthError when Google answers no
 * refresh token, the Gmail scope was not granted, or no verified address.
 */
export async function exchangeGoogleSenderCode(props: {
  client: GoogleOAuthClient
  code: string
  redirectUri: string
}): Promise<GoogleSenderGrant> {
  const { status, body } = await tokenCall({
    grant_type: "authorization_code",
    code: props.code,
    redirect_uri: props.redirectUri,
    client_id: props.client.clientId,
    client_secret: props.client.clientSecret,
  })
  const access = accessTokenOf(body, status)
  const scope = typeof body?.scope === "string" ? body.scope : ""
  if (!scope.split(" ").includes(GMAIL_SCOPE)) {
    throw new GoogleOAuthError("gmail-scope-not-granted", {
      status,
      retryable: false,
    })
  }
  const refreshToken = body?.refresh_token
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new GoogleOAuthError("no-refresh-token", {
      status,
      retryable: false,
    })
  }
  const email = idTokenEmail(body?.id_token, props.client.clientId)
  if (!email) {
    throw new GoogleOAuthError("no-verified-email", {
      status,
      retryable: false,
    })
  }
  return { ...access, refreshToken, scope, email }
}

/**
 * A fresh access token. Google keeps the refresh token (it answers a new
 * one only on a rotation, which the caller then stores).
 */
export async function refreshGoogleAccessToken(props: {
  client: GoogleOAuthClient
  refreshToken: string
}): Promise<GoogleAccessToken & { refreshToken: string | null }> {
  const { status, body } = await tokenCall({
    grant_type: "refresh_token",
    refresh_token: props.refreshToken,
    client_id: props.client.clientId,
    client_secret: props.client.clientSecret,
  })
  const rotated = body?.refresh_token
  return {
    ...accessTokenOf(body, status),
    refreshToken:
      typeof rotated === "string" && rotated.length > 0 ? rotated : null,
  }
}
