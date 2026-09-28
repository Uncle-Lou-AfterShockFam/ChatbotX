import { isMintedGuestConversationId } from "@chatbotx.io/partysocket-config/guest-id"
import { GUEST_SECRET_REGEX } from "@chatbotx.io/partysocket-config/guest-secret"

const GUEST_CONVERSATION_ID_KEY = "x-conversation-id"
export const LEGACY_GLOBAL_KEY = GUEST_CONVERSATION_ID_KEY
const GUEST_SESSION_KEY = "x-guest-session"

const memoryStorage = new Map<string, string>()

/**
 * The pre-s215 per-webchat key: it held a bare id with no secret. Such a
 * visitor is refused by every guest route (owner s215), so it is only removed.
 */
export const buildGuestStorageKey = (workspaceId: string, webchatId: string) =>
  `${GUEST_CONVERSATION_ID_KEY}:${workspaceId}:${webchatId}`

/** Where a visitor's id and secret live together, per webchat (s215). */
export const buildGuestSessionKey = (workspaceId: string, webchatId: string) =>
  `${GUEST_SESSION_KEY}:${workspaceId}:${webchatId}`

export type GuestSessionCredentials = {
  guestConversationId: string
  guestSecret: string
}

/**
 * The stored pair, or null when there is none or it is not a minted id of
 * this workspace with a well-formed secret (unparseable, a bare id, foreign).
 */
export const readGuestSession = (
  key: string,
  workspaceId: string,
): GuestSessionCredentials | null => {
  const raw = safeStorageGet(key)
  if (!raw) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null
  }
  const { guestConversationId, guestSecret } = parsed as Record<string, unknown>
  if (
    !isMintedGuestConversationId(guestConversationId, workspaceId) ||
    typeof guestSecret !== "string" ||
    !GUEST_SECRET_REGEX.test(guestSecret)
  ) {
    return null
  }
  return { guestConversationId, guestSecret }
}

export const writeGuestSession = (
  key: string,
  { guestConversationId, guestSecret }: GuestSessionCredentials,
) => {
  safeStorageSet(key, JSON.stringify({ guestConversationId, guestSecret }))
}

export const safeStorageGet = (key: string) => {
  try {
    return (
      globalThis.localStorage?.getItem(key) ?? memoryStorage.get(key) ?? null
    )
  } catch {
    return memoryStorage.get(key) ?? null
  }
}

export const safeStorageSet = (key: string, value: string) => {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    memoryStorage.set(key, value)
  }
}

export const safeStorageRemove = (key: string) => {
  memoryStorage.delete(key)
  try {
    globalThis.localStorage?.removeItem(key)
  } catch {
    // Storage blocked: the in-memory copy above is all there was.
  }
}
