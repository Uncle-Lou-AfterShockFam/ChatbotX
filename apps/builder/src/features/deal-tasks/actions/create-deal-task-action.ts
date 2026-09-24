"use server"

import { dealTaskService } from "@chatbotx.io/business/deal-task"
import type { PermissionsInput } from "@chatbotx.io/business/workspace-member/permissions"
import { zodBigintAsString } from "@chatbotx.io/utils"
import type z from "zod"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { viewerFromActionCtx } from "@/features/deals/lib/viewer"
import {
  requireContactsSectionAccess,
  workspaceActionClient,
} from "@/lib/safe-action"
import { createDealTaskRequest } from "../schema/action"

const input = createDealTaskRequest.extend({ dealId: zodBigintAsString() })

export const createDealTaskAction = workspaceActionClient
  .use(requireContactsSectionAccess)
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
      ctx: {
        user: { id: string }
        workspaceMemberPermissions: PermissionsInput
      }
    }) => {
      const { dealId, ...data } = parsedInput
      return dealTaskService.create({
        workspaceId,
        dealId,
        data,
        actorId: ctx.user.id,
        viewer: viewerFromActionCtx(ctx),
      })
    },
  )
