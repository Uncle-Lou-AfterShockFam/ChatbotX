"use server"

import { dealService } from "@chatbotx.io/business/deal"
import { zodBigintAsString } from "@chatbotx.io/utils"
import type z from "zod"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { workspaceActionClient } from "@/lib/safe-action"
import { moveDealRequest } from "../schema/action"

const input = moveDealRequest.extend({ id: zodBigintAsString() })

export const moveDealAction = workspaceActionClient
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
      dealService.moveStage({
        workspaceId,
        id: parsedInput.id,
        stageId: parsedInput.stageId,
        position: parsedInput.position,
        actorId: ctx.user.id,
      }),
  )
