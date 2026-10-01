"use server"

import { flowVersionService } from "@chatbotx.io/business"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { flowsActionClient } from "@/lib/safe-action"

export const revertToPublishedAction = flowsActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .action(async (props) => {
    const {
      bindArgsParsedInputs: [workspaceId, flowId],
    } = props

    const { nodes, edges } = await flowVersionService.revertDraftToPublished({
      workspaceId,
      flowId,
    })

    return { nodes, edges }
  })
