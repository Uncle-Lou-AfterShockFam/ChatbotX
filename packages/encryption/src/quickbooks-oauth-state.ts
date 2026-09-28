import { randomBytes, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import {
  signAppointmentToken,
  verifyAppointmentToken,
} from "./appointment-token-utils"

const STATE_AAD = "quickbooks-oauth-state"
/** Long enough to sign in to Intuit and pick a company; no longer. */
export const QUICKBOOKS_OAUTH_STATE_TTL_MS = 15 * 60 * 1000
/** The HttpOnly cookie that carries the nonce the state must match. */
export const QUICKBOOKS_OAUTH_NONCE_COOKIE = "qbo_oauth_nonce"
const NONCE = /^[A-Za-z0-9_-]{43}$/

export const quickbooksOAuthStateSchema = z
  .object({
    workspaceId: z.string().min(1).max(32),
    userId: z.string().min(1).max(64),
    nonce: z.string().regex(NONCE),
    expiresAt: z.number(),
  })
  .strict()
export type QuickbooksOAuthState = z.infer<typeof quickbooksOAuthStateSchema>

/** 256 random bits, base64url: the value of the nonce cookie. */
export const mintQuickbooksOAuthNonce = (): string =>
  randomBytes(32).toString("base64url")

/**
 * The `state` of a QuickBooks connect (s214b). The fork's other OAuth
 * callbacks take a bare base64 state, so any page could replay a victim's
 * code into its own workspace; this one is ENCRYPTED (authenticated, bound
 * to its purpose by the AAD), expires, names the user and workspace that
 * started the connect, and carries a nonce that must equal the HttpOnly
 * cookie set on the same browser.
 */
export async function signQuickbooksOAuthState(
  payload: Omit<QuickbooksOAuthState, "expiresAt">,
  ttlMs = QUICKBOOKS_OAUTH_STATE_TTL_MS,
): Promise<string> {
  return await signAppointmentToken(
    quickbooksOAuthStateSchema.parse({
      ...payload,
      expiresAt: Date.now() + ttlMs,
    }),
    STATE_AAD,
  )
}

/**
 * The verified state, or null when it is malformed, tampered, minted for
 * another purpose, expired, started by another user, or its nonce is not
 * the cookie's.
 */
export async function verifyQuickbooksOAuthState(props: {
  state: unknown
  nonceCookie: unknown
  userId: string
}): Promise<QuickbooksOAuthState | null> {
  if (
    typeof props.state !== "string" ||
    props.state.length === 0 ||
    props.state.length > 4096 ||
    typeof props.nonceCookie !== "string" ||
    !NONCE.test(props.nonceCookie)
  ) {
    return null
  }
  let payload: QuickbooksOAuthState
  try {
    payload = await verifyAppointmentToken(
      props.state,
      STATE_AAD,
      quickbooksOAuthStateSchema,
    )
  } catch {
    return null
  }
  const given = Buffer.from(props.nonceCookie)
  const expected = Buffer.from(payload.nonce)
  if (
    payload.userId !== props.userId ||
    given.length !== expected.length ||
    !timingSafeEqual(given, expected)
  ) {
    return null
  }
  return payload
}
