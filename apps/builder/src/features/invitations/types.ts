import type { WorkspaceModel } from "@chatbotx.io/database/types"

/**
 * What the invitation page sends to the client card: only the fields it
 * renders (s233a). Never the raw rows: the workspace row carries the
 * deprecated plaintext `token`.
 */
export type InvitationView = {
  code: string
  inviterName: string | null
  workspace: Pick<
    WorkspaceModel,
    "name" | "logo" | "scheduledDeletionAt"
  > | null
}
