"use server"

import { folderService } from "@chatbotx.io/business"
import { workspaceIdrequestParams } from "@/features/common/schema"
import { assertFolderTypeAccess } from "@/features/folders/lib/folder-permission"
import { workspaceActionClient } from "@/lib/safe-action"
import { changeFolderRequest } from "../schema/action"

export const changeFolderAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(changeFolderRequest)
  .action(async ({ bindArgsParsedInputs, parsedInput, ctx }) => {
    const [workspaceId] = bindArgsParsedInputs
    assertFolderTypeAccess(
      ctx.workspaceMemberPermissions,
      parsedInput.folderType,
    )

    await folderService.changeFolder({
      workspaceId,
      folderType: parsedInput.folderType,
      modelIds: parsedInput.modelIds,
      newFolderId: parsedInput.newFolderId,
    })
  })
