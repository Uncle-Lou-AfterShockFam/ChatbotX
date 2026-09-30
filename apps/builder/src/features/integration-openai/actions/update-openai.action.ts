"use server"
import { aiIntegrationService } from "@chatbotx.io/ai/server"
import { integrationOpenAIService } from "@chatbotx.io/business"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { workspaceActionClient } from "@/lib/safe-action"
import {
  type UpdateOpenAIRequest,
  updateOpenAIRequest,
} from "../schema/request"

export const updateIntegrationOpenAIAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .inputSchema(updateOpenAIRequest)
  .action(async (props) => {
    const {
      bindArgsParsedInputs: [workspaceId, id],
      parsedInput,
    } = props

    // The row carries the plaintext API key in `auth`; an action result is
    // serialized to the browser, so return only what the switch reads.
    const { autoReply } = await updateIntegrationOpenAI(
      { workspaceId, id },
      parsedInput,
    )
    return { autoReply }
  })

export const updateIntegrationOpenAI = async (
  ctx: {
    workspaceId: string
    id: string
  },
  parsedInput: UpdateOpenAIRequest,
) => {
  const result = await integrationOpenAIService.update(ctx, parsedInput)

  await aiIntegrationService.invalidateCache(ctx.workspaceId, "openai")

  return result
}
