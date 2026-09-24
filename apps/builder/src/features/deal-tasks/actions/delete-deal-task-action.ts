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
})

export const deleteDealTaskAction = workspaceActionClient
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
      await dealTaskService.remove({ workspaceId, ...parsedInput })
      return { deleted: true as const }
    },
  )
