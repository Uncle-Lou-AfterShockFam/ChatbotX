import "server-only"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import {
  signGuestSecret,
  verifyGuestSecret,
} from "@chatbotx.io/partysocket-config/guest-secret"
import { env } from "@/env"
import {
  createGuestConversationId,
  GUEST_SECRET_REFUSED_MESSAGE,
} from "./guest-conversation-id"

/**
 * A new guest id and its secret, minted together by the `/webchat` page. The
 * only place a secret is ever signed: an id a caller brings is never given
 * one, so a leaked `sourceId` stays useless.
 */
export const mintGuestSession = async (workspaceId: string) => {
  const guestConversationId = createGuestConversationId(workspaceId)
  const guestSecret = await signGuestSecret(
    guestConversationId,
    env.REALTIME_BROADCAST_SECRET,
  )
  return { guestConversationId, guestSecret }
}

/**
 * Throws the one refusal every guest route shares unless `guestSecret` is the
 * secret of `guestConversationId` in `workspaceId`. A 401, not the token's
 * 403, so the widget starts a fresh conversation instead of refreshing its
 * token (a stored secret from before a key rotation lands here).
 */
export const assertGuestSecret = async (input: {
  guestConversationId: unknown
  guestSecret: unknown
  workspaceId: string
}) => {
  const valid = await verifyGuestSecret(
    input.guestConversationId,
    input.guestSecret,
    env.REALTIME_BROADCAST_SECRET,
    input.workspaceId,
  )
  if (!valid) {
    throw new ChatbotXException(
      GUEST_SECRET_REFUSED_MESSAGE,
      "guestSecretRefused",
      401,
    )
  }
}
