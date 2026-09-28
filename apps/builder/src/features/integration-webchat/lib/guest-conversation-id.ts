import { isMintedGuestConversationId } from "@chatbotx.io/partysocket-config/guest-id"
import { z } from "zod"

// A cryptographically random (128-bit), unguessable id — not the sequential
// Snowflake createId(). Since s215 the id is an identifier, not a credential
// (it is `ContactInbox.sourceId`, which the API and exports show): the visitor
// proves ownership with the guest secret minted beside it (guest-secret.ts).
export const createGuestConversationId = (workspaceId: string) =>
  `${workspaceId}:${crypto.randomUUID()}`

// Only the minted form above is accepted (s213): the legacy digits-only
// Snowflake is guessable.
// Deliberately NOT zodBigintAsString() -- the minted form is not digits-only.
export const zodGuestConversationId = () =>
  z.string().refine((value) => isMintedGuestConversationId(value), {
    message: "Invalid guest conversation id",
  })

// The id's workspace prefix must be the request's workspace, checked at parse
// time so a mismatched id never reaches a ContactInbox lookup.
export const refineGuestIdWorkspace = (
  data: { guestConversationId: string; workspaceId: string },
  ctx: z.RefinementCtx,
) => {
  if (
    !isMintedGuestConversationId(data.guestConversationId, data.workspaceId)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["guestConversationId"],
      message: "Guest conversation id belongs to another workspace",
    })
  }
}

/** The header the widget sends its guest secret in on GET calls (s215). */
export const GUEST_SECRET_HEADER = "x-guest-secret"

/**
 * The message of a refused guest secret (a 401). Shared with the widget, which
 * matches it on a server-action send error to start a fresh conversation.
 */
export const GUEST_SECRET_REFUSED_MESSAGE = "Guest session is no longer valid"

// Its format is checked by verifyGuestSecret; the bound only stops a huge
// value reaching it.
export const zodGuestSecret = () => z.string().max(128).optional()
