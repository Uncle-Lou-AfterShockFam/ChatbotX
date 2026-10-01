import { ChatbotXException } from "@chatbotx.io/business/errors"
import type { WorkspaceMemberPermissions } from "@chatbotx.io/database/partials"
import { hasWorkspacePermission } from "@/lib/auth/permission-routes"

/**
 * s231b (owner 2026-10-01; blind probe): an EMAIL line's token reads every
 * mailbox sender's credentials through the sender feed, so minting a new one
 * (rotate), deleting the channel, or marking / unmarking it is for a REAL
 * workspace admin only - never a plain member, never a platform-support
 * session (its synthetic membership carries superAdmin).
 */
export function assertEmailLineAdmin(
  ctx: {
    workspaceMemberPermissions: WorkspaceMemberPermissions
    isSupportSession: boolean
  },
  what: string,
): void {
  if (
    ctx.isSupportSession ||
    !hasWorkspacePermission(ctx.workspaceMemberPermissions, "superAdmin")
  ) {
    throw new ChatbotXException(
      `Only a workspace admin can ${what} an email line`,
      "emailLineSuperAdminRequired",
      403,
    )
  }
}
