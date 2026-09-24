"use server"

import { dealService } from "@chatbotx.io/business/deal"
import { zodBigintAsString } from "@chatbotx.io/utils"
import type z from "zod"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { workspaceActionClient } from "@/lib/safe-action"
import { updateDealRequest } from "../schema/action"

const input = updateDealRequest.extend({ id: zodBigintAsString() })

export const updateDealAction = workspaceActionClient
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
      const { id, ...data } = parsedInput
      return dealService.update({
        workspaceId,
        id,
        data,
        actorId: ctx.user.id,
      })
    },
  )
