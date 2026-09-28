import { ChatbotXException } from "@chatbotx.io/business/errors"
import { hasWorkspacePermission } from "@/lib/auth/permission-routes"
import { workspaceActionClient } from "@/lib/safe-action"

/**
 * Shared gate for every QuickBooks action (s214b): connecting, mirroring
 * and disconnecting a workspace's books are super-admin only, applied once
 * so a new action can't forget it (same shape as `templateActionClient`).
 */
export const quickbooksActionClient = workspaceActionClient.use(
  ({ ctx, next }) => {
    if (!hasWorkspacePermission(ctx.workspaceMemberPermissions, "superAdmin")) {
      throw new ChatbotXException(
        "You need to be a super admin to manage QuickBooks",
        "quickbooksSuperAdminRequired",
        403,
      )
    }
    return next()
  },
)
