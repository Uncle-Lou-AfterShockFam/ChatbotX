"use server"

import { replyClassificationService } from "@chatbotx.io/business/reply-classification"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { workspaceActionClient } from "@/lib/safe-action"

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
