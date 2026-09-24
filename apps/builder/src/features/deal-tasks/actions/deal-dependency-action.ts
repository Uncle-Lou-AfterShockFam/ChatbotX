"use server"

import { dealTaskService } from "@chatbotx.io/business/deal-task"
import type { PermissionsInput } from "@chatbotx.io/business/workspace-member/permissions"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { viewerFromActionCtx } from "@/features/deals/lib/viewer"
import {
  requireContactsSectionAccess,
  workspaceActionClient,
} from "@/lib/safe-action"

const input = z.object({
  dealId: zodBigintAsString(),
  taskId: zodBigintAsString(),
  dependsOnTaskId: zodBigintAsString(),
  remove: z.boolean().optional(),
})

/** Add (default) or remove one dependency edge. */
export const dealDependencyAction = workspaceActionClient
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
    }) => {
      const { remove, ...edge } = parsedInput
      const viewer = viewerFromActionCtx(ctx)
      if (remove) {
        return await dealTaskService.removeDependency({
          workspaceId,
          ...edge,
          viewer,
        })
      }
      const row = await dealTaskService.addDependency({
        workspaceId,
        ...edge,
        viewer,
      })
      return { taskId: row.taskId, dependsOnTaskId: row.dependsOnTaskId }
    },
  )
