"use server"

import { dealService } from "@chatbotx.io/business/deal"
import type { PermissionsInput } from "@chatbotx.io/business/workspace-member/permissions"
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
import { deleteDealsRequest } from "../schema/action"

export const deleteDealsAction = workspaceActionClient
  .use(requireContactsSectionAccess)
  .inputSchema(deleteDealsRequest)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
      ctx,
    }: {
      parsedInput: z.infer<typeof deleteDealsRequest>
      bindArgsParsedInputs: WorkspaceIdRequestParams
      ctx: {
        user: { id: string }
        workspaceMemberPermissions: PermissionsInput
      }
    }) =>
      dealService.remove({
        workspaceId,
        ids: parsedInput.ids,
        viewer: viewerFromActionCtx(ctx),
      }),
  )
