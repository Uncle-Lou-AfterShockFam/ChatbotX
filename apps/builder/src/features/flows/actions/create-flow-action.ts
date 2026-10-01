"use server"

import { flowService } from "@chatbotx.io/business"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { flowsActionClient } from "@/lib/safe-action"
import { type CreateFlowSchema, createFlowSchema } from "../schema/action"

export const createFlowAction = flowsActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(createFlowSchema)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId],
      parsedInput,
    }: {
      bindArgsParsedInputs: WorkspaceIdRequestParams
      parsedInput: CreateFlowSchema
    }) =>
      await flowService.createDraft({
        workspaceId,
        data: parsedInput,
      }),
  )
