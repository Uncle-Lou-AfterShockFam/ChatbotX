"use server"

import { pipelineService } from "@chatbotx.io/business"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { workspaceActionClient } from "@/lib/safe-action"
import {
  createPipelineRequest,
  removeStageRequest,
  reorderStagesRequest,
  updatePipelineRequest,
  upsertStageRequest,
} from "../schema/action"

type Bound = { bindArgsParsedInputs: WorkspaceIdRequestParams }

export const createPipelineAction = workspaceActionClient
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
  .inputSchema(updateInput)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput: { id, ...data },
      bindArgsParsedInputs: [workspaceId],
    }: Bound & { parsedInput: z.infer<typeof updateInput> }) =>
      pipelineService.update({ workspaceId, id, data }),
  )

const deleteInput = z.object({
  id: zodBigintAsString(),
  force: z.boolean().optional(),
})
export const deletePipelineAction = workspaceActionClient
  .inputSchema(deleteInput)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
    }: Bound & { parsedInput: z.infer<typeof deleteInput> }) =>
      pipelineService.remove({ workspaceId, ...parsedInput }),
  )

const upsertStageInput = upsertStageRequest.extend({
  pipelineId: zodBigintAsString(),
})
export const upsertStageAction = workspaceActionClient
  .inputSchema(upsertStageInput)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput: { pipelineId, stageId, ...data },
      bindArgsParsedInputs: [workspaceId],
    }: Bound & { parsedInput: z.infer<typeof upsertStageInput> }) =>
      pipelineService.upsertStage({ workspaceId, pipelineId, stageId, data }),
  )

const reorderInput = reorderStagesRequest.extend({
  pipelineId: zodBigintAsString(),
})
export const reorderStagesAction = workspaceActionClient
  .inputSchema(reorderInput)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
    }: Bound & { parsedInput: z.infer<typeof reorderInput> }) =>
      pipelineService.reorderStages({ workspaceId, ...parsedInput }),
  )

const removeStageInput = removeStageRequest.extend({
  pipelineId: zodBigintAsString(),
})
export const removeStageAction = workspaceActionClient
  .inputSchema(removeStageInput)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
    }: Bound & { parsedInput: z.infer<typeof removeStageInput> }) =>
      pipelineService.removeStage({ workspaceId, ...parsedInput }),
  )
