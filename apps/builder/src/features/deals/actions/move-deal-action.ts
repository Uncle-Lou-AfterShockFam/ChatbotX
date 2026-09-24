"use server"

import { dealService } from "@chatbotx.io/business/deal"
import type { PermissionsInput } from "@chatbotx.io/business/workspace-member/permissions"
import { zodBigintAsString } from "@chatbotx.io/utils"
import type z from "zod"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import {
  requireContactsSectionAccess,
  workspaceActionClient,
} from "@/lib/safe-action"
import { viewerFromActionCtx } from "../lib/viewer"
import { moveDealRequest } from "../schema/action"

const input = moveDealRequest.extend({ id: zodBigintAsString() })

export const moveDealAction = workspaceActionClient
  .use(requireContactsSectionAccess)
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
      ctx: {
        user: { id: string }
        workspaceMemberPermissions: PermissionsInput
      }
    }) =>
      dealService.moveStage({
        workspaceId,
        id: parsedInput.id,
        stageId: parsedInput.stageId,
        position: parsedInput.position,
        actorId: ctx.user.id,
        viewer: viewerFromActionCtx(ctx),
      }),
  )
