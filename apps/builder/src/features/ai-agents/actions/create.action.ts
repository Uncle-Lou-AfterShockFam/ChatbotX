"use server"

import { aiAgentService } from "@chatbotx.io/business"
import { createAIAgentRequest } from "@/features/ai-agents/schema/action"
import { workspaceIdrequestParams } from "@/features/common/schema"
import { flowsActionClient } from "@/lib/safe-action"

export const createAIAgentAction = flowsActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(createAIAgentRequest)
  .action(async (props) => {
    const {
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
    } = props

    await aiAgentService.create(workspaceId, parsedInput)
  })
