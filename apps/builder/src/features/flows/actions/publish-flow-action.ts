"use server"

import { flowVersionService } from "@chatbotx.io/business"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { flowsActionClient } from "@/lib/safe-action"
import { publishFlowSchema } from "../schema/action"

export const publishFlowAction = flowsActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .inputSchema(publishFlowSchema)
  .action(async (props) => {
    const {
      bindArgsParsedInputs: [workspaceId, id],
      parsedInput,
    } = props

    await flowVersionService.publish({
      workspaceId,
      flowId: id,
      nodes: parsedInput.nodes,
      edges: parsedInput.edges,
    })
  })
