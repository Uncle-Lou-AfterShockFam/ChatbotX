"use server"

import { folderService } from "@chatbotx.io/business"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { assertFolderIdsAccess } from "@/features/folders/lib/folder-permission"
import { editFolderSchema } from "@/features/folders/schema/action"
import { workspaceActionClient } from "@/lib/safe-action"

export const editFolderAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .inputSchema(editFolderSchema)
  .action(async (props) => {
    const {
      bindArgsParsedInputs: [workspaceId, id],
      parsedInput,
      ctx,
    } = props

    await assertFolderIdsAccess({
      workspaceId,
      permissions: ctx.workspaceMemberPermissions,
      ids: [id],
    })

    await folderService.update({
      workspaceId,
      id,
      data: parsedInput,
    })
  })
