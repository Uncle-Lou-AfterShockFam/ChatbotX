import { randomBytes, timingSafeEqual } from "node:crypto"
import type { z } from "zod"
import {
  signAppointmentToken,
  verifyAppointmentToken,
} from "./appointment-token-utils"

/** The HttpOnly cookie value: 256 random bits, base64url. */
export const OAUTH_NONCE = /^[A-Za-z0-9_-]{43}$/
/** Long enough to sign in at the provider and consent; no longer. */
export const OAUTH_STATE_TTL_MS = 15 * 60 * 1000

export const mintOAuthNonce = (): string =>
  randomBytes(32).toString("base64url")

type StateBase = { userId: string; nonce: string; expiresAt: number }

/**
 * The `state` of one OAuth connect flow (s214b QuickBooks, s230b email
 * senders). The fork's older OAuth callbacks take a bare base64 state, so
 * any page could replay a victim's code into its own workspace; this one is
 * ENCRYPTED (authenticated, bound to its purpose by `aad`), expires, names
 * the user who started the connect, and carries a nonce that must equal the
 * HttpOnly cookie set on the same browser.
 */
export function oauthState<T extends StateBase>(props: {
  aad: string
  schema: z.ZodType<T>
  ttlMs?: number
  /** The longest state accepted (a longer one is refused unread). */
  maxLength?: number
}) {
  const defaultTtl = props.ttlMs ?? OAUTH_STATE_TTL_MS
  const maxLength = props.maxLength ?? 4096
  return {
    async sign(
      payload: Omit<T, "expiresAt">,
      ttlMs = defaultTtl,
    ): Promise<string> {
      return await signAppointmentToken(
        props.schema.parse({ ...payload, expiresAt: Date.now() + ttlMs }),
        props.aad,
      )
    },
    /**
     * The verified state, or null when it is malformed, tampered, minted
     * for another purpose, expired, started by another user, or its nonce
     * is not the cookie's.
     */
    async verify(input: {
      state: unknown
      nonceCookie: unknown
      userId: string
    }): Promise<T | null> {
      if (
        typeof input.state !== "string" ||
        input.state.length === 0 ||
        input.state.length > maxLength ||
        typeof input.nonceCookie !== "string" ||
        !OAUTH_NONCE.test(input.nonceCookie)
      ) {
        return null
      }
      let payload: T
      try {
        payload = await verifyAppointmentToken(
          input.state,
          props.aad,
          props.schema,
        )
      } catch {
        return null
      }
      const given = Buffer.from(input.nonceCookie)
      const expected = Buffer.from(payload.nonce)
      if (
        payload.userId !== input.userId ||
        given.length !== expected.length ||
        !timingSafeEqual(given, expected)
      ) {
        return null
      }
      return payload
    },
  }
}
