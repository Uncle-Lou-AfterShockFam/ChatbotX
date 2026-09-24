"use server"

import { dealTaskTemplateService } from "@chatbotx.io/business/deal-task"
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
import { upsertDealTaskTemplateRequest } from "../schema/action"

const upsertInput = upsertDealTaskTemplateRequest.extend({
  pipelineId: zodBigintAsString(),
  stageId: zodBigintAsString(),
  templateId: zodBigintAsString().nullish(),
})

export const upsertTaskTemplateAction = workspaceActionClient
  .use(requireContactsSectionAccess)
  .inputSchema(upsertInput)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
      ctx,
    }: {
      parsedInput: z.infer<typeof upsertInput>
      bindArgsParsedInputs: WorkspaceIdRequestParams
      ctx: {
        user: { id: string }
        workspaceMemberPermissions: PermissionsInput
      }
    }) => {
      const { pipelineId, stageId, templateId, ...data } = parsedInput
      return dealTaskTemplateService.upsert({
        workspaceId,
        pipelineId,
        stageId,
        templateId,
        data,
        viewer: viewerFromActionCtx(ctx),
      })
    },
  )

const removeInput = z.object({
  pipelineId: zodBigintAsString(),
  stageId: zodBigintAsString(),
  templateId: zodBigintAsString(),
})

export const removeTaskTemplateAction = workspaceActionClient
  .use(requireContactsSectionAccess)
  .inputSchema(removeInput)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
      ctx,
    }: {
      parsedInput: z.infer<typeof removeInput>
      bindArgsParsedInputs: WorkspaceIdRequestParams
      ctx: {
        user: { id: string }
        workspaceMemberPermissions: PermissionsInput
      }
    }) => {
      await dealTaskTemplateService.remove({
        workspaceId,
        ...parsedInput,
        viewer: viewerFromActionCtx(ctx),
      })
      return { deleted: true as const }
    },
  )
