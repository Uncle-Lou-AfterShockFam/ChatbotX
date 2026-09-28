import { hmacSha256Hex, timingSafeStringEqual } from "@chatbotx.io/utils/crypto"
import { isMintedGuestConversationId } from "./guest-id"

// The webchat guest id is an identifier, not a credential (owner s215): it is
// `ContactInbox.sourceId`, which the public API, CSV export and flow variables
// all expose. A visitor proves they own a conversation with this secret
// instead: an HMAC of the id under a key derived from the realtime broadcast
// secret, so the builder and the realtime server (no database) can both check
// it. It is stateless: nothing secret is stored, and rotating the broadcast
// secret ends every guest session.
const GUEST_SECRET_KEY_LABEL = "cbx-guest-secret-v1"
const GUEST_SECRET_REGEX = /^[0-9a-f]{64}$/
const MIN_BROADCAST_SECRET_LENGTH = 32

const deriveGuestSecretKey = (broadcastSecret: string) =>
  hmacSha256Hex(broadcastSecret, GUEST_SECRET_KEY_LABEL)

/**
 * The secret for a freshly minted guest id. Only the builder's `/webchat`
 * page calls this, and only for an id it just minted: never for an id a
 * caller supplied, which would hand a leaked id its credential.
 */
export const signGuestSecret = async (
  guestConversationId: string,
  broadcastSecret: string,
): Promise<string> => {
  if (!isMintedGuestConversationId(guestConversationId)) {
    throw new TypeError("signGuestSecret: not a minted guest conversation id")
  }
  if (
    typeof broadcastSecret !== "string" ||
    broadcastSecret.length < MIN_BROADCAST_SECRET_LENGTH
  ) {
    throw new TypeError("signGuestSecret: broadcast secret missing or short")
  }
  return await hmacSha256Hex(
    await deriveGuestSecretKey(broadcastSecret),
    guestConversationId,
  )
}

/**
 * True only when `secret` is the secret of a minted `guestConversationId`
 * (of `workspaceId`, when given). Never throws: a missing, non-string,
 * malformed or wrong secret, a non-minted or foreign id, or a missing
 * broadcast secret are all false (fail closed).
 */
export const verifyGuestSecret = async (
  guestConversationId: unknown,
  secret: unknown,
  broadcastSecret: unknown,
  workspaceId?: string,
): Promise<boolean> => {
  if (!isMintedGuestConversationId(guestConversationId, workspaceId)) {
    return false
  }
  if (typeof secret !== "string" || !GUEST_SECRET_REGEX.test(secret)) {
    return false
  }
  if (
    typeof broadcastSecret !== "string" ||
    broadcastSecret.length < MIN_BROADCAST_SECRET_LENGTH
  ) {
    return false
  }
  const expected = await signGuestSecret(guestConversationId, broadcastSecret)
  return timingSafeStringEqual(expected, secret)
}
