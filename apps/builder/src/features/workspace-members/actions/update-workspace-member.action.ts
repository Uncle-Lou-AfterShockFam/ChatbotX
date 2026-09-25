"use server"

import { isDeepStrictEqual } from "node:util"
import { userService, workspaceMemberService } from "@chatbotx.io/business"
import { auditService } from "@chatbotx.io/business/audit"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import { isCommunity } from "@/env"
import { workspaceIdAndIdRequestParams } from "@/features/common/schema"
import { hasWorkspacePermission } from "@/lib/auth/permission-routes"
import { getCurrentUserAndTargetWorkspace } from "@/lib/auth/utils"
import { workspaceActionClient } from "@/lib/safe-action"
import {
  getSuperAdminPermissions,
  normalizeContactsPermissions,
} from "../helpers"
import { updateWorkspaceMemberRequest } from "../schema/mutation"

export const updateWorkspaceMemberAction = workspaceActionClient
  .inputSchema(updateWorkspaceMemberRequest)
  .bindArgsSchemas(workspaceIdAndIdRequestParams)
  .action(async ({ bindArgsParsedInputs: [workspaceId, id], parsedInput }) => {
    const workspaceMember = await workspaceMemberService.findByIdOrFail({
      id,
      workspaceId,
    })

    const currentUserAndTargetChatbot =
      await getCurrentUserAndTargetWorkspace(workspaceId)
    if (!currentUserAndTargetChatbot) {
      throw new ChatbotXException(
        "You are not authorized to update this workspace member",
      )
    }

    const permissions =
      currentUserAndTargetChatbot.targetWorkspaceMember.permissions
    if (!hasWorkspacePermission(permissions, "superAdmin")) {
      throw new ChatbotXException(
        "You are not authorized to update this workspace member. You need to be a super admin to do this.",
      )
    }

    const permissionsInput = isCommunity()
      ? getSuperAdminPermissions()
      : normalizeContactsPermissions(parsedInput.permissions)

    const permissionsChanged = !isDeepStrictEqual(
      workspaceMember.permissions,
      permissionsInput,
    )
    // s198: only the flags the admin changed on THIS form (against the
    // values it was opened with) are written, merged into the stored jsonb:
    // diffing against the fresh row would write the stale form back over a
    // member's own self-service change made since the page loaded.
    const notificationPatch = {
      types: changedFlags(
        parsedInput.notificationTypes,
        parsedInput.loadedNotificationTypes,
      ),
      channels: changedFlags(
        parsedInput.notificationChannels,
        parsedInput.loadedNotificationChannels,
      ),
    }
    const notificationsChanged =
      Object.keys(notificationPatch.types).length > 0 ||
      Object.keys(notificationPatch.channels).length > 0

    // updateWorkspaceMemberRequest = permissions + the notification flags
    // (+ their loaded values). A new field MUST be diffed here too, or it
    // will silently never be persisted.
    if (!(permissionsChanged || notificationsChanged)) {
      return
    }

    const updated = await workspaceMemberService.update({
      id: workspaceMember.id,
      workspaceId,
      data: permissionsChanged ? { permissions: permissionsInput } : {},
      notificationPatch,
    })

    if (!updated) {
      return
    }

    // Only a real permissions/role change is in the audit-log spec for this
    // action — a save that only touches notification settings must not be
    // recorded as a "changed role" event.
    if (permissionsChanged) {
      const targetUser = await userService.findNameAndEmail(
        workspaceMember.userId,
      )

      await auditService.record({
        action: "role_change",
        detail: `changed role of ${targetUser?.name ?? targetUser?.email ?? "a member"} to ${permissionsInput.superAdmin ? "admin" : "member"}`,
      })
    }
  })

/** The flags whose submitted value differs from the value the form loaded. */
function changedFlags(
  submitted: Record<string, boolean>,
  loaded: Record<string, boolean>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(submitted)) {
    if (loaded[key] !== value) {
      out[key] = value
    }
  }
  return out
}
