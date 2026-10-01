"use server"

import { flowService } from "@chatbotx.io/business"
import {
  type BulkUpdateIdsRequest,
  bulkUpdateIdsRequest,
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { flowsActionClientAllowExpired } from "@/lib/safe-action"

export const deleteFlowAction = flowsActionClientAllowExpired
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(bulkUpdateIdsRequest)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId],
      parsedInput,
    }: {
      bindArgsParsedInputs: WorkspaceIdRequestParams
      parsedInput: BulkUpdateIdsRequest
    }) => {
      await flowService.deleteMany({ workspaceId, ids: parsedInput.ids })
    },
  )
