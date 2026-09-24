"use server"

import { dealService } from "@chatbotx.io/business/deal"
import { zodBigintAsString } from "@chatbotx.io/utils"
import type z from "zod"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { workspaceActionClient } from "@/lib/safe-action"
import { setDealStatusRequest } from "../schema/action"

const input = setDealStatusRequest.extend({ id: zodBigintAsString() })

export const setDealStatusAction = workspaceActionClient
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
    }) =>
      dealService.setStatus({
        workspaceId,
        id: parsedInput.id,
        status: parsedInput.status,
        actorId: ctx.user.id,
      }),
  )
