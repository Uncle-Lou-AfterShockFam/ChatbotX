"use server"

import { dealService } from "@chatbotx.io/business/deal"
import type z from "zod"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { workspaceActionClient } from "@/lib/safe-action"
import { deleteDealsRequest } from "../schema/action"

export const deleteDealsAction = workspaceActionClient
  .inputSchema(deleteDealsRequest)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
    }: {
      parsedInput: z.infer<typeof deleteDealsRequest>
      bindArgsParsedInputs: WorkspaceIdRequestParams
    }) => dealService.remove({ workspaceId, ids: parsedInput.ids }),
  )
