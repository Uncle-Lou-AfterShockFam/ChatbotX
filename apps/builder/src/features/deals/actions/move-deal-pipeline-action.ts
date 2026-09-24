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
import { moveDealPipelineRequest } from "../schema/action"

const input = moveDealPipelineRequest.extend({ id: zodBigintAsString() })

export const moveDealPipelineAction = workspaceActionClient
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
      dealService.movePipeline({
        workspaceId,
        id: parsedInput.id,
        pipelineId: parsedInput.pipelineId,
        stageId: parsedInput.stageId,
        fields: parsedInput.fields,
        ownerId: parsedInput.ownerId,
        actorId: ctx.user.id,
        viewer: viewerFromActionCtx(ctx),
      }),
  )
