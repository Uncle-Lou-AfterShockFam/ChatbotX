"use server"

import { dealTaskService } from "@chatbotx.io/business/deal-task"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { workspaceActionClient } from "@/lib/safe-action"

const input = z.object({
  dealId: zodBigintAsString(),
  taskId: zodBigintAsString(),
  force: z.boolean().optional(),
  /** true = reopen instead of complete */
  reopen: z.boolean().optional(),
})

export const completeDealTaskAction = workspaceActionClient
  .inputSchema(input)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
      ctx,
    }: {
      parsedInput: z.infer<typeof input>
      bindArgsParsedInputs: WorkspaceIdRequestParams
      ctx: { user: { id: string } }
    }) => {
      const { dealId, taskId, force, reopen } = parsedInput
      if (reopen) {
        const task = await dealTaskService.reopen({
          workspaceId,
          dealId,
          taskId,
        })
        return { task, completed: false }
      }
      return await dealTaskService.complete({
        workspaceId,
        dealId,
        taskId,
        force,
        actorId: ctx.user.id,
      })
    },
  )
