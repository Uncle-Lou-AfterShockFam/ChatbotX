"use server"

import { aiAgentService } from "@chatbotx.io/business"
import {
  bulkUpdateIdsRequest,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { flowsActionClientAllowExpired } from "@/lib/safe-action"

export const deleteAIAgentAction = flowsActionClientAllowExpired
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(bulkUpdateIdsRequest)
  .action(async (props) => {
    const {
      bindArgsParsedInputs: [workspaceId],
      parsedInput: { ids },
    } = props

    await aiAgentService.delete({ workspaceId, ids })
  })
