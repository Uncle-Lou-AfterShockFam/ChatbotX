import { z } from "zod"
import {
  mintOAuthNonce,
  OAUTH_NONCE,
  OAUTH_STATE_TTL_MS,
  oauthState,
} from "./oauth-state"

/** Long enough to sign in to Intuit and pick a company; no longer. */
export const QUICKBOOKS_OAUTH_STATE_TTL_MS = OAUTH_STATE_TTL_MS
/** The HttpOnly cookie that carries the nonce the state must match. */
export const QUICKBOOKS_OAUTH_NONCE_COOKIE = "qbo_oauth_nonce"

export const quickbooksOAuthStateSchema = z
  .object({
    workspaceId: z.string().min(1).max(32),
    userId: z.string().min(1).max(64),
    nonce: z.string().regex(OAUTH_NONCE),
    expiresAt: z.number(),
  })
  .strict()
export type QuickbooksOAuthState = z.infer<typeof quickbooksOAuthStateSchema>

/** 256 random bits, base64url: the value of the nonce cookie. */
export const mintQuickbooksOAuthNonce = mintOAuthNonce

const state = oauthState({
  aad: "quickbooks-oauth-state",
  schema: quickbooksOAuthStateSchema,
})

/** The `state` of a QuickBooks connect (s214b); see `oauthState`. */
export const signQuickbooksOAuthState = state.sign
export const verifyQuickbooksOAuthState = state.verify
