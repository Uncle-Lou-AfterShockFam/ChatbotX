"use server"

import { folderService } from "@chatbotx.io/business"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { assertFolderTypeAccess } from "@/features/folders/lib/folder-permission"
import {
  type CreateFolderSchema,
  createFolderSchema,
} from "@/features/folders/schema/action"
import type { PermissionsInput } from "@/lib/auth/permission-routes"
import { workspaceActionClient } from "@/lib/safe-action"

export const createFolderAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(createFolderSchema)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId],
      parsedInput,
      ctx,
    }: {
      bindArgsParsedInputs: WorkspaceIdRequestParams
      parsedInput: CreateFolderSchema
      ctx: { workspaceMemberPermissions: PermissionsInput }
    }) => {
      assertFolderTypeAccess(
        ctx.workspaceMemberPermissions,
        parsedInput.folderType,
      )
      await folderService.create({ workspaceId, data: parsedInput })
    },
  )
