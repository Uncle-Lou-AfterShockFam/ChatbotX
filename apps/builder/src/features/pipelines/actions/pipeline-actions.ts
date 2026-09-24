"use server"

import { pipelineMemberService, pipelineService } from "@chatbotx.io/business"
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
import {
  createPipelineRequest,
  removeStageRequest,
  reorderStagesRequest,
  setPipelineMembersRequest,
  updatePipelineRequest,
  upsertStageRequest,
} from "../schema/action"

type Bound = {
  bindArgsParsedInputs: WorkspaceIdRequestParams
  ctx: { user: { id: string }; workspaceMemberPermissions: PermissionsInput }
}

export const createPipelineAction = workspaceActionClient
  .use(requireContactsSectionAccess)
  .inputSchema(createPipelineRequest)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
    }: Bound & { parsedInput: z.infer<typeof createPipelineRequest> }) =>
      pipelineService.create({ workspaceId, data: parsedInput }),
  )

const updateInput = updatePipelineRequest.extend({ id: zodBigintAsString() })
export const updatePipelineAction = workspaceActionClient
  .use(requireContactsSectionAccess)
  .inputSchema(updateInput)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput: { id, ...data },
      bindArgsParsedInputs: [workspaceId],
      ctx,
    }: Bound & { parsedInput: z.infer<typeof updateInput> }) =>
      pipelineService.update({
        workspaceId,
        id,
        data,
        viewer: viewerFromActionCtx(ctx),
      }),
  )

const deleteInput = z.object({
  id: zodBigintAsString(),
  force: z.boolean().optional(),
})
export const deletePipelineAction = workspaceActionClient
  .use(requireContactsSectionAccess)
  .inputSchema(deleteInput)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
      ctx,
    }: Bound & { parsedInput: z.infer<typeof deleteInput> }) =>
      pipelineService.remove({
        workspaceId,
        ...parsedInput,
        viewer: viewerFromActionCtx(ctx),
      }),
  )

const upsertStageInput = upsertStageRequest.extend({
  pipelineId: zodBigintAsString(),
})
export const upsertStageAction = workspaceActionClient
  .use(requireContactsSectionAccess)
  .inputSchema(upsertStageInput)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput: { pipelineId, stageId, ...data },
      bindArgsParsedInputs: [workspaceId],
      ctx,
    }: Bound & { parsedInput: z.infer<typeof upsertStageInput> }) =>
      pipelineService.upsertStage({
        workspaceId,
        pipelineId,
        stageId,
        data,
        viewer: viewerFromActionCtx(ctx),
      }),
  )

const reorderInput = reorderStagesRequest.extend({
  pipelineId: zodBigintAsString(),
})
export const reorderStagesAction = workspaceActionClient
  .use(requireContactsSectionAccess)
  .inputSchema(reorderInput)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
      ctx,
    }: Bound & { parsedInput: z.infer<typeof reorderInput> }) =>
      pipelineService.reorderStages({
        workspaceId,
        ...parsedInput,
        viewer: viewerFromActionCtx(ctx),
      }),
  )

const removeStageInput = removeStageRequest.extend({
  pipelineId: zodBigintAsString(),
})
export const removeStageAction = workspaceActionClient
  .use(requireContactsSectionAccess)
  .inputSchema(removeStageInput)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
      ctx,
    }: Bound & { parsedInput: z.infer<typeof removeStageInput> }) =>
      pipelineService.removeStage({
        workspaceId,
        ...parsedInput,
        viewer: viewerFromActionCtx(ctx),
      }),
  )

const setMembersInput = setPipelineMembersRequest.extend({
  pipelineId: zodBigintAsString(),
})
export const setPipelineMembersAction = workspaceActionClient
  .use(requireContactsSectionAccess)
  .inputSchema(setMembersInput)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
      ctx,
    }: Bound & { parsedInput: z.infer<typeof setMembersInput> }) =>
      pipelineMemberService.set({
        workspaceId,
        pipelineId: parsedInput.pipelineId,
        members: parsedInput.members,
        viewer: viewerFromActionCtx(ctx),
      }),
  )
