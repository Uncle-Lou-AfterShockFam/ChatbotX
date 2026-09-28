"use server"

import { integrationQuickbooksService } from "@chatbotx.io/business/integration-quickbooks"
import { z } from "zod"
import { workspaceIdrequestParams } from "@/features/common/schema"
import { hasWorkspacePermission } from "@/lib/auth/permission-routes"
import { workspaceActionClient } from "@/lib/safe-action"

const requireSuperAdmin = (permissions: unknown) => {
  if (
    !hasWorkspacePermission(
      permissions as Parameters<typeof hasWorkspacePermission>[0],
      "superAdmin",
    )
  ) {
    throw new Error("You need to be a super admin to change QuickBooks")
  }
}

/** Turn the bookkeeping mirror on or off (s214b). */
export const setQuickbooksMirrorAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(z.object({ enabled: z.boolean() }).strict())
  .action(async ({ ctx, bindArgsParsedInputs: [workspaceId], parsedInput }) => {
    requireSuperAdmin(ctx.workspaceMemberPermissions)
    const summary = await integrationQuickbooksService.setMirror({
      workspaceId,
      enabled: parsedInput.enabled,
    })
    return { mirrorEnabled: summary.mirrorEnabled }
  })

/** Disconnect; refused while a quickbooks invoice is still live. */
export const disconnectQuickbooksAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(async ({ ctx, bindArgsParsedInputs: [workspaceId] }) => {
    requireSuperAdmin(ctx.workspaceMemberPermissions)
    await integrationQuickbooksService.disconnect(workspaceId)
  })
