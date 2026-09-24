import { pipelineMemberService, pipelineService } from "@chatbotx.io/business"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"
import { viewerFromContext } from "@/features/deals/lib/viewer"
import { withWorkspaceIdSchema } from "@/features/workspaces/schema/resource"
import { contactsAccessAuthorizedMiddleware } from "@/middlewares/auth"
import { authorizedAPI } from "@/orpc"
import {
  createPipelineRequest,
  deletePipelineRequest,
  removeStageRequest,
  reorderStagesRequest,
  setPipelineMembersRequest,
  updatePipelineRequest,
  upsertStageRequest,
} from "../schema/action"
import {
  pipelineMemberResource,
  pipelineStageResource,
  pipelineWithStagesResource,
} from "../schema/resource"

const withPipelineId = withWorkspaceIdSchema.and(
  z.object({ id: zodBigintAsString() }),
)

const privateListWorkspacePipelinesAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/pipelines",
    summary: "List pipelines with their stages",
    tags: ["Pipelines"],
  })
  .input(withWorkspaceIdSchema)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ data: z.array(pipelineWithStagesResource) }))
  .handler(async ({ input, context }) => ({
    data: await pipelineService.list({
      ...input,
      viewer: viewerFromContext(context),
    }),
  }))

const privateGetPipelineAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/pipelines/{id}",
    summary: "Get a pipeline",
    tags: ["Pipelines"],
  })
  .input(withPipelineId)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(pipelineWithStagesResource)
  .handler(
    async ({ input, context }) =>
      await pipelineService.find({
        ...input,
        viewer: viewerFromContext(context),
      }),
  )

const privateCreatePipelineAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/pipelines",
    summary: "Create a pipeline",
    tags: ["Pipelines"],
  })
  .input(createPipelineRequest.and(withWorkspaceIdSchema))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(pipelineWithStagesResource)
  .handler(async ({ input }) => {
    const { workspaceId, ...data } = input
    return await pipelineService.create({ workspaceId, data })
  })

const privateUpdatePipelineAPI = authorizedAPI
  .route({
    method: "PUT",
    path: "/workspaces/{workspaceId}/pipelines/{id}",
    summary: "Update a pipeline",
    tags: ["Pipelines"],
  })
  .input(updatePipelineRequest.and(withPipelineId))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(pipelineWithStagesResource)
  .handler(async ({ input }) => {
    const { workspaceId, id, ...data } = input
    return await pipelineService.update({ workspaceId, id, data })
  })

const privateDeletePipelineAPI = authorizedAPI
  .route({
    method: "DELETE",
    path: "/workspaces/{workspaceId}/pipelines/{id}",
    summary: "Delete a pipeline",
    tags: ["Pipelines"],
  })
  .input(deletePipelineRequest.and(withPipelineId))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ deletedDeals: z.number().int() }))
  .handler(async ({ input }) => await pipelineService.remove(input))

const privateUpsertPipelineStageAPI = authorizedAPI
  .route({
    method: "PUT",
    path: "/workspaces/{workspaceId}/pipelines/{id}/stages",
    summary: "Create or update a stage",
    tags: ["Pipelines"],
  })
  .input(upsertStageRequest.and(withPipelineId))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(pipelineStageResource)
  .handler(async ({ input }) => {
    const { workspaceId, id, stageId, ...data } = input
    return await pipelineService.upsertStage({
      workspaceId,
      pipelineId: id,
      stageId,
      data,
    })
  })

const privateReorderPipelineStagesAPI = authorizedAPI
  .route({
    method: "PUT",
    path: "/workspaces/{workspaceId}/pipelines/{id}/stages/order",
    summary: "Reorder stages",
    tags: ["Pipelines"],
  })
  .input(reorderStagesRequest.and(withPipelineId))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.array(pipelineStageResource))
  .handler(async ({ input }) => {
    const { workspaceId, id, stageIds } = input
    return await pipelineService.reorderStages({
      workspaceId,
      pipelineId: id,
      stageIds,
    })
  })

const privateRemovePipelineStageAPI = authorizedAPI
  .route({
    method: "DELETE",
    path: "/workspaces/{workspaceId}/pipelines/{id}/stages/{stageId}",
    summary: "Remove a stage",
    tags: ["Pipelines"],
  })
  .input(removeStageRequest.and(withPipelineId))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ movedDeals: z.number().int() }))
  .handler(async ({ input }) => {
    const { workspaceId, id, stageId, moveDealsTo } = input
    return await pipelineService.removeStage({
      workspaceId,
      pipelineId: id,
      stageId,
      moveDealsTo,
    })
  })

const privateListPipelineMembersAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/pipelines/{id}/members",
    summary: "Members of a pipeline in rotation order",
    tags: ["Pipelines"],
  })
  .input(withPipelineId)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ data: z.array(pipelineMemberResource) }))
  .handler(async ({ input, context }) => {
    await pipelineService.findOrFail({
      workspaceId: input.workspaceId,
      id: input.id,
      viewer: viewerFromContext(context),
    })
    return {
      data: await pipelineMemberService.list({
        workspaceId: input.workspaceId,
        pipelineId: input.id,
      }),
    }
  })

const privateSetPipelineMembersAPI = authorizedAPI
  .route({
    method: "PUT",
    path: "/workspaces/{workspaceId}/pipelines/{id}/members",
    summary: "Replace the members of a pipeline",
    tags: ["Pipelines"],
  })
  .input(setPipelineMembersRequest.and(withPipelineId))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ data: z.array(pipelineMemberResource) }))
  .handler(async ({ input, context }) => {
    await pipelineService.findOrFail({
      workspaceId: input.workspaceId,
      id: input.id,
      viewer: viewerFromContext(context),
    })
    return {
      data: await pipelineMemberService.set({
        workspaceId: input.workspaceId,
        pipelineId: input.id,
        members: input.members,
      }),
    }
  })

export const privatePipelinesAPI = {
  privateListPipelineMembersAPI,
  privateSetPipelineMembersAPI,
  privateListWorkspacePipelinesAPI,
  privateGetPipelineAPI,
  privateCreatePipelineAPI,
  privateUpdatePipelineAPI,
  privateDeletePipelineAPI,
  privateUpsertPipelineStageAPI,
  privateReorderPipelineStagesAPI,
  privateRemovePipelineStageAPI,
}
