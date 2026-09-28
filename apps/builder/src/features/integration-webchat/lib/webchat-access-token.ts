import { Buffer } from "node:buffer"
import { createId } from "@chatbotx.io/utils"
import { hmacSha256Hex, timingSafeStringEqual } from "@chatbotx.io/utils/crypto"
import { getHostFromOrigin } from "./authorized-domain"
import { TOKEN_TTL_SECONDS } from "./webchat-token-expiry"

export { TOKEN_TTL_SECONDS } from "./webchat-token-expiry"

// A real token is ~200 chars; anything far longer is refused unparsed.
const MAX_TOKEN_LENGTH = 2048

type WebchatAccessTokenPayloadShape = {
  exp: unknown
  originHost: unknown
  webchatId: unknown
  workspaceId: unknown
  sid?: unknown
}

export type WebchatAccessTokenPayload = {
  exp: number
  // Normalized host (not the raw origin/referer string) so mint-time values
  // (a full referer URL with path) and verify-time values (a bare
  // `window.location.origin`) compare equal — see getHostFromOrigin.
  originHost: string | null
  webchatId: string
  workspaceId: string
  /**
   * The widget session: minted with the page's token and carried by every
   * refresh, so the refresh rate limit has a key the caller cannot rotate
   * (s212). Null on a token minted before the claim existed.
   */
  sid: string | null
}

type WebchatAccessTokenInput = {
  origin?: string | null
  webchatId: string
  workspaceId: string
  /** A refresh passes the old token's session; a page load starts one. */
  sid?: string | null
}

const MAX_SID_LENGTH = 64

type WebchatAccessTokenVerification = {
  authorized: boolean
}

const base64UrlEncode = (value: string) =>
  Buffer.from(value, "utf8").toString("base64url")

const base64UrlDecode = (value: string) =>
  Buffer.from(value, "base64url").toString("utf8")

const signPayload = (payload: string) => {
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is required")
  }
  return hmacSha256Hex(secret, payload)
}

export const createWebchatAccessToken = async ({
  workspaceId,
  webchatId,
  origin,
  sid,
}: WebchatAccessTokenInput) => {
  const payload: WebchatAccessTokenPayload = {
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    originHost: getHostFromOrigin(origin),
    webchatId,
    workspaceId,
    sid: sid || createId(),
  }
  const encodedPayload = base64UrlEncode(JSON.stringify(payload))
  const signature = await signPayload(encodedPayload)
  return `${encodedPayload}.${signature}`
}

export const verifyWebchatAccessToken = async ({
  token,
  workspaceId,
  webchatId,
  origin,
}: WebchatAccessTokenInput & {
  token?: string | null
}): Promise<WebchatAccessTokenVerification> => {
  const unauthorized: WebchatAccessTokenVerification = { authorized: false }

  if (!token) {
    return unauthorized
  }

  const payload = await readWebchatAccessToken(token)
  if (!payload) {
    return unauthorized
  }
  // Bind-on-first-use: the token always carries the host it was minted
  // for (captured from the referer at page-load time), and every caller
  // must present a matching host to use it — this holds regardless of
  // whether the webchat has an admin-configured authorizedDomains
  // allowlist. Compare normalized hosts (not raw strings) since mint-time
  // (referer header, may include a path) and verify-time
  // (window.location.origin, bare) values differ in shape even for the
  // same site.
  //
  // Threat model: the `origin` passed in here at verify time is
  // client-supplied (a request body/query field), not read from a
  // server-trusted header, and the mint-time `referer` can itself be
  // forged by a direct (non-browser) caller. So this check stops a
  // *passive* leaked/replayed token from being reused from a genuinely
  // different origin (that origin's real `window.location.origin` won't
  // match the host baked into someone else's token) — it does NOT stop an
  // *active* attacker who controls both the mint request's Referer and the
  // verify request's origin field and can simply keep them consistent.
  // The admin-configured authorizedDomains allowlist has the same
  // limitation (also checked against the client-supplied origin). Treat
  // both as defense-in-depth, not a substitute for origin verification
  // from a trusted transport-layer signal.
  //
  // The token is session-scoped only (workspace/webchat/origin/exp) and
  // is not bound to a specific guestConversationId: the iframe embed has
  // no way to round-trip the client's persisted id back to the server
  // (it lives in the iframe's own localStorage, unreachable from
  // plugin.js), so a returning visitor's page reload always mints a
  // fresh token while the client still presents its old persisted id.
  // Binding the token to an id would reject that legitimate case. The
  // conversation itself is proved by the guest secret stored with the id
  // (guest-secret.ts, s215), checked separately on every guest route.
  const authorized =
    payload.workspaceId === workspaceId &&
    payload.webchatId === webchatId &&
    payload.originHost === getHostFromOrigin(origin) &&
    payload.exp >= Math.floor(Date.now() / 1000)

  return { authorized }
}

/**
 * The payload of a token WE signed, expired or not; null for anything else
 * (no token, bad shape, bad signature, malformed JSON or fields). The refresh
 * route reads an expired token through this (s210).
 */
export const readWebchatAccessToken = async (
  token: string | null | undefined,
): Promise<WebchatAccessTokenPayload | null> => {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) {
    return null
  }
  const [encodedPayload, signature, extra] = token.split(".")
  if (!(encodedPayload && signature) || extra !== undefined) {
    return null
  }
  const expectedSignature = await signPayload(encodedPayload)
  if (!timingSafeStringEqual(signature, expectedSignature)) {
    return null
  }
  try {
    const payload = JSON.parse(
      base64UrlDecode(encodedPayload),
    ) as WebchatAccessTokenPayloadShape | null
    if (
      !payload ||
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.exp) ||
      !(
        payload.originHost === null || typeof payload.originHost === "string"
      ) ||
      typeof payload.webchatId !== "string" ||
      typeof payload.workspaceId !== "string" ||
      !(
        payload.sid === undefined ||
        (typeof payload.sid === "string" &&
          payload.sid.length > 0 &&
          payload.sid.length <= MAX_SID_LENGTH)
      )
    ) {
      return null
    }
    return {
      exp: payload.exp,
      originHost: payload.originHost,
      webchatId: payload.webchatId,
      workspaceId: payload.workspaceId,
      sid: payload.sid ?? null,
    }
  } catch {
    return null
  }
}
