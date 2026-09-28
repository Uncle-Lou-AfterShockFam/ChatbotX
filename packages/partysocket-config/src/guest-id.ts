// The webchat guest conversation id names a conversation and its realtime
// `guests` room. Ownership is proved by the guest secret minted beside it
// (guest-secret.ts, s215); the id is still accepted only in the minted,
// unguessable form `<workspaceId>:<uuidv4>`. The legacy digits-only
// Snowflake (sequential, guessable) is refused; production held none when the
// legacy form was retired (s213: 9 webchat ContactInbox rows, 0 digits-only).
export const GUEST_CONVERSATION_ID_REGEX =
  /^\d{1,20}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// Longest possible minted id: 20 digits + ":" + 36-char uuid.
const MAX_GUEST_CONVERSATION_ID_LENGTH = 57

/**
 * True only for a minted `<workspaceId>:<uuid>` id. With `workspaceId`, the
 * prefix must also be that workspace, so an id from one workspace is never
 * accepted in another. Anything else (null, non-string, empty, digits-only,
 * oversize) is false.
 */
export const isMintedGuestConversationId = (
  value: unknown,
  workspaceId?: string,
): value is string => {
  if (typeof value !== "string") {
    return false
  }
  if (value.length > MAX_GUEST_CONVERSATION_ID_LENGTH) {
    return false
  }
  if (!GUEST_CONVERSATION_ID_REGEX.test(value)) {
    return false
  }
  return workspaceId === undefined || value.startsWith(`${workspaceId}:`)
}
