"use server"

import { folderService } from "@chatbotx.io/business"
import {
  type BulkUpdateIdsRequest,
  bulkUpdateIdsRequest,
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { assertFolderIdsAccess } from "@/features/folders/lib/folder-permission"
import type { PermissionsInput } from "@/lib/auth/permission-routes"
import { workspaceActionClient } from "@/lib/safe-action"

export const deleteFolderAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(bulkUpdateIdsRequest)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId],
      parsedInput,
      ctx,
    }: {
      bindArgsParsedInputs: WorkspaceIdRequestParams
      parsedInput: BulkUpdateIdsRequest
      ctx: { workspaceMemberPermissions: PermissionsInput }
    }) => {
      await assertFolderIdsAccess({
        workspaceId,
        permissions: ctx.workspaceMemberPermissions,
        ids: parsedInput.ids,
      })
      await folderService.bulkDelete({ workspaceId, ids: parsedInput.ids })
    },
  )
