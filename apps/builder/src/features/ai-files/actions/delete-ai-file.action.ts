"use server"

import { aiFileService } from "@chatbotx.io/business"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { flowsActionClientAllowExpired } from "@/lib/safe-action"

export const deleteAIFileAction = flowsActionClientAllowExpired
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .action(async (props) => {
    const {
      bindArgsParsedInputs: [workspaceId, id],
    } = props

    return await aiFileService.delete({ workspaceId, id })
  })
