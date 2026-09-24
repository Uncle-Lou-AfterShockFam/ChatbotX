"use server"

import { dealTaskService } from "@chatbotx.io/business/deal-task"
import { zodBigintAsString } from "@chatbotx.io/utils"
import type z from "zod"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { workspaceActionClient } from "@/lib/safe-action"
import { updateDealTaskRequest } from "../schema/action"

const input = updateDealTaskRequest.extend({
  dealId: zodBigintAsString(),
  taskId: zodBigintAsString(),
})

export const updateDealTaskAction = workspaceActionClient
  .inputSchema(input)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
      ctx,
    }: {
      parsedInput: z.infer<typeof input>
      bindArgsParsedInputs: WorkspaceIdRequestParams
      ctx: { user: { id: string } }
    }) => {
      const { dealId, taskId, ...data } = parsedInput
      return dealTaskService.update({
        workspaceId,
        dealId,
        taskId,
        data,
        actorId: ctx.user.id,
      })
    },
  )
