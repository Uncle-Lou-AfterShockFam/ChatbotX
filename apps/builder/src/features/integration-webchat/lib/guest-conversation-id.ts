import { isMintedGuestConversationId } from "@chatbotx.io/partysocket-config/guest-id"
import { z } from "zod"

// A cryptographically random (128-bit), unguessable id — not the sequential
// Snowflake createId(). The webchat access token is session-scoped only (see
// webchat-access-token.ts) and does not bind to this id, so possession of the
// id itself is the only remaining evidence that a caller previously created
// this guest session; a sequential/enumerable id would let anyone mint a
// valid token for a stranger's conversation just by guessing nearby ids.
export const createGuestConversationId = (workspaceId: string) =>
  `${workspaceId}:${crypto.randomUUID()}`

// Only the minted form above is accepted (s213): the legacy digits-only
// Snowflake is guessable, and the id is the conversation's only credential.
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
