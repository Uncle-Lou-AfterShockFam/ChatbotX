"use server"
import { aiIntegrationService } from "@chatbotx.io/ai/server"
import { integrationOpenAIService } from "@chatbotx.io/business"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { workspaceActionClient } from "@/lib/safe-action"
import { updateOpenAIRequest } from "../schema/request"

export const updateIntegrationOpenAIAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .inputSchema(updateOpenAIRequest)
  .action(async (props) => {
    const {
      bindArgsParsedInputs: [workspaceId, id],
      parsedInput,
    } = props

    const { autoReply } = await integrationOpenAIService.update(
      { workspaceId, id },
      parsedInput,
    )
    await aiIntegrationService.invalidateCache(workspaceId, "openai")

    // The row carries the plaintext API key in `auth`, and an action result
    // is serialized to the browser: return only what the switch reads. No
    // other export here: every export of a "use server" file is a Server
    // Action, and a bare helper would skip the workspace check and the zod
    // parse.
    return { autoReply }
  })
