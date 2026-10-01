import { z } from "zod"
import { mintOAuthNonce, OAUTH_NONCE, oauthState } from "./oauth-state"

/** The HttpOnly cookie that carries the nonce the state must match. */
export const EMAIL_SENDER_OAUTH_NONCE_COOKIE = "email_sender_oauth_nonce"
/** The cookie's path: only the callback ever receives it. */
export const EMAIL_SENDER_OAUTH_COOKIE_PATH = "/integrations/email-sender"
export { OAUTH_STATE_TTL_MS as EMAIL_SENDER_OAUTH_STATE_TTL_MS } from "./oauth-state"
export const mintEmailSenderOAuthNonce = mintOAuthNonce

const id = z.string().regex(/^\d{1,19}$/)
/** A display name the sender is created with (the connect dialog's). */
const identity = z.string().min(1).max(100)

/**
 * The `state` of a Google mailbox-sender connect (s230b): who started it,
 * for which workspace and email line, and either the sender it RECONNECTS
 * or the identity a new sender is created with.
 */
export const emailSenderOAuthStateSchema = z
  .object({
    workspaceId: id,
    userId: z.string().min(1).max(64),
    lineInboxId: id,
    senderId: id.optional(),
    fromName: identity.optional(),
    firstName: identity.optional(),
    lastName: identity.optional(),
    nonce: z.string().regex(OAUTH_NONCE),
    expiresAt: z.number(),
  })
  .strict()
export type EmailSenderOAuthState = z.infer<typeof emailSenderOAuthStateSchema>

const state = oauthState({
  aad: "email-sender-oauth-state",
  schema: emailSenderOAuthStateSchema,
  // Three 100-character names in 4-byte UTF-8 fit; the state is base64url
  // of an encrypted JSON blob (about 1.8x the payload).
  maxLength: 8192,
})

export const signEmailSenderOAuthState = state.sign
export const verifyEmailSenderOAuthState = state.verify
