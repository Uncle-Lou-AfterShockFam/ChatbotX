"use server"

import { replyClassificationService } from "@chatbotx.io/business/reply-classification"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { workspaceActionClient } from "@/lib/safe-action"

/** s228b: create an Outreach pipeline and link it to the sequence. */
export const createOutreachPipelineAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .inputSchema(z.object({ name: z.string().trim().min(1).max(100).optional() }))
  .action(async (props) => {
    const {
      bindArgsParsedInputs: [workspaceId, sequenceId],
      parsedInput,
    } = props
    return await replyClassificationService.createOutreachPipeline({
      workspaceId,
      sequenceId,
      name: parsedInput.name,
    })
  })

/** s228b: unlink the sequence's Outreach pipeline (it and its deals stay). */
export const unlinkOutreachPipelineAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .action(async (props) => {
    const {
      bindArgsParsedInputs: [workspaceId, sequenceId],
    } = props
    await replyClassificationService.unlinkOutreachPipeline({
      workspaceId,
      sequenceId,
    })
    return { ok: true }
  })
