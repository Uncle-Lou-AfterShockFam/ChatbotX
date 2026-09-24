"use server"

import { dealService } from "@chatbotx.io/business/deal"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { workspaceActionClient } from "@/lib/safe-action"
import { type CreateDealRequest, createDealRequest } from "../schema/action"

export const createDealAction = workspaceActionClient
  .inputSchema(createDealRequest)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
      ctx,
    }: {
      parsedInput: CreateDealRequest
      bindArgsParsedInputs: WorkspaceIdRequestParams
      ctx: { user: { id: string } }
    }) =>
      dealService.create({
        workspaceId,
        data: parsedInput,
        actorId: ctx.user.id,
      }),
  )
