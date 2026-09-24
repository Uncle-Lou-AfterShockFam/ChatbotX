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
  dependsOnTaskId: zodBigintAsString(),
  remove: z.boolean().optional(),
})

/** Add (default) or remove one dependency edge. */
export const dealDependencyAction = workspaceActionClient
  .inputSchema(input)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
    }: {
      parsedInput: z.infer<typeof input>
      bindArgsParsedInputs: WorkspaceIdRequestParams
    }) => {
      const { remove, ...edge } = parsedInput
      if (remove) {
        return await dealTaskService.removeDependency({ workspaceId, ...edge })
      }
      const row = await dealTaskService.addDependency({ workspaceId, ...edge })
      return { taskId: row.taskId, dependsOnTaskId: row.dependsOnTaskId }
    },
  )
