"use server"

import {
  quotaEnforcementService,
  workspaceService,
} from "@chatbotx.io/business"
import { auditService } from "@chatbotx.io/business/audit"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import { db } from "@chatbotx.io/database/client"
import { invitationModel } from "@chatbotx.io/database/schema"
import { createId, SymbolicSnowflakeIDs } from "@chatbotx.io/utils"
import { addDays } from "date-fns"
import { isCommunity } from "@/env"
import { workspaceIdrequestParams } from "@/features/common/schema"
import { hasWorkspacePermission } from "@/lib/auth/permission-routes"
import { getCurrentUserAndTargetWorkspace } from "@/lib/auth/utils"
import { workspaceActionClient } from "@/lib/safe-action"
import {
  getSuperAdminPermissions,
  normalizeContactsPermissions,
} from "../helpers"
import { inviteWorkspaceMemberRequest } from "../schema/mutation"

export const inviteWorkspaceMemberAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(inviteWorkspaceMemberRequest)
  .action(async ({ ctx, parsedInput, bindArgsParsedInputs: [workspaceId] }) => {
    // Read-only gate: team-member usage is reconcile-counted after acceptance,
    // so block issuing an invitation once the owner is already at the limit.
    const workspace = await workspaceService.findById({ id: workspaceId })
    const currentUserAndTargetChatbot =
      await getCurrentUserAndTargetWorkspace(workspaceId)
    if (!currentUserAndTargetChatbot) {
      throw new ChatbotXException(
        "You are not authorized to invite a workspace member",
      )
    }

    // s231b (blind probe): a platform-support session never mints or raises a
    // REAL membership - it would launder its synthetic access into a lasting
    // admin row that every support-session gate then trusts.
    if (currentUserAndTargetChatbot.isSupportSession) {
      throw new ChatbotXException(
        "Platform support sessions cannot change workspace members",
        "supportSessionBlocked",
        403,
      )
    }

    const currentPermissions =
      currentUserAndTargetChatbot.targetWorkspaceMember.permissions
    if (!hasWorkspacePermission(currentPermissions, "superAdmin")) {
      throw new ChatbotXException(
        "You are not authorized to invite a workspace member. You need to be a super admin to do this.",
      )
    }

    const atLimit = await quotaEnforcementService.hasReachedLimit({
      userId: workspace.ownerId,
      metric: "teamMembers",
    })
    if (atLimit) {
      throw new ChatbotXException(
        "Team member limit reached for this workspace plan",
      )
    }

    const permissions = isCommunity()
      ? getSuperAdminPermissions()
      : normalizeContactsPermissions(parsedInput.permissions)

    const invitation = await db
      .insert(invitationModel)
      .values({
        id: createId(),
        code: SymbolicSnowflakeIDs.generate(),
        permissions,
        expiresAt: addDays(new Date(), 1),
        workspaceId,
        invitedBy: ctx.user.id,
      })
      .returning()
      .then((result) => result[0])

    // No email/name is captured at invite time (invite is a shareable
    // code/link, not addressed to a specific person), so the detail can only
    // name the role being granted.
    await auditService.record({
      action: "invite",
      detail: `invited a new ${permissions.superAdmin ? "admin" : "member"}`,
    })

    return invitation
  })
