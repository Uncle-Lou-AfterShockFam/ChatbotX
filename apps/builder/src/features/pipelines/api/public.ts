import { pipelineService } from "@chatbotx.io/business"
import { z } from "zod"
import {
  possibleErrorsOnCreatingEmailTopic,
  possibleErrorsOnDeletingResource,
  possibleErrorsOnFindingResource,
  possibleErrorsOnListingResource,
  possibleErrorsOnMutatingEmailTopic,
  possibleErrorsOnMutatingResource,
} from "@/lib/orpc/orpc-error-helper"
import { workspaceTokenAuthAPIForScope } from "@/orpc"
import {
  createPipelinePublicRequest,
  pipelineIdInput,
  pipelinePublicResource,
  pipelineStagePublicResource,
  removeStagePublicRequest,
  reorderStagesPublicRequest,
  updatePipelinePublicRequest,
  upsertStagePublicRequest,
} from "../schema/public"

const workspaceTokenAuthAPI = workspaceTokenAuthAPIForScope("contacts")

export const pipelinesPublicRouter = {
  list: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/pipelines",
      summary: "List pipelines",
      description:
        "Returns every deal pipeline in this workspace with its stages in order. Pipelines are few, so the list is not paged.",
      tags: ["Pipelines"],
    })
    .output(z.object({ data: z.array(pipelinePublicResource) }))
    .errors(possibleErrorsOnListingResource)
    .handler(async ({ context }) => ({
      data: await pipelineService.list({ workspaceId: context.workspace.id }),
    })),

  get: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/pipelines/{id}",
      summary: "Get pipeline",
      description:
        "Returns one pipeline with its stages in order. Use `pipelines.list` to find its id.",
      tags: ["Pipelines"],
    })
    .input(pipelineIdInput)
    .output(pipelinePublicResource)
    .errors(possibleErrorsOnFindingResource)
    .handler(
      async ({ context, input }) =>
        await pipelineService.find({
          workspaceId: context.workspace.id,
          id: input.id,
        }),
    ),

  create: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/pipelines",
      summary: "Create pipeline",
      description:
        "Adds a deal pipeline. Without `stages` it starts with New, Qualified, Won and Lost; `settings.stopCompanyOn` decides when a deal stops the contact's company.",
      successStatus: 201,
      tags: ["Pipelines"],
    })
    .input(createPipelinePublicRequest)
    .output(pipelinePublicResource)
    .errors(possibleErrorsOnCreatingEmailTopic)
    .handler(
      async ({ context, input }) =>
        await pipelineService.create({
          workspaceId: context.workspace.id,
          data: input,
        }),
    ),

  update: workspaceTokenAuthAPI
    .route({
      method: "PATCH",
      path: "/v1/pipelines/{id}",
      summary: "Update pipeline",
      description:
        "Merges the given fields into a pipeline: its name or its settings (stopCompanyOn, defaultCurrency). Omitted fields are left unchanged.",
      tags: ["Pipelines"],
    })
    .input(updatePipelinePublicRequest)
    .output(pipelinePublicResource)
    .errors(possibleErrorsOnMutatingEmailTopic)
    .handler(async ({ context, input }) => {
      const { id, ...data } = input
      return await pipelineService.update({
        workspaceId: context.workspace.id,
        id,
        data,
      })
    }),

  delete: workspaceTokenAuthAPI
    .route({
      method: "DELETE",
      path: "/v1/pipelines/{id}",
      summary: "Delete pipeline",
      description:
        "Deletes a pipeline with its stages and deals. Refused while open deals remain unless `force` is true.",
      tags: ["Pipelines"],
    })
    .input(
      pipelineIdInput.extend({
        force: z
          .boolean()
          .optional()
          .describe(
            "Delete even when open deals remain in the pipeline; they are deleted too.",
          ),
      }),
    )
    .output(
      z.object({
        deletedDeals: z
          .number()
          .int()
          .describe("How many deals were deleted with the pipeline."),
      }),
    )
    .errors(possibleErrorsOnDeletingResource)
    .handler(
      async ({ context, input }) =>
        await pipelineService.remove({
          workspaceId: context.workspace.id,
          id: input.id,
          force: input.force,
        }),
    ),

  upsertStage: workspaceTokenAuthAPI
    .route({
      method: "PUT",
      path: "/v1/pipelines/{id}/stages",
      summary: "Create or update stage",
      description:
        "With `stageId` updates that stage; without it appends a new stage to the pipeline. `isWon` / `isLost` mark the closing columns.",
      tags: ["Pipelines"],
    })
    .input(upsertStagePublicRequest)
    .output(pipelineStagePublicResource)
    .errors(possibleErrorsOnMutatingResource)
    .handler(async ({ context, input }) => {
      const { id, stageId, ...data } = input
      return await pipelineService.upsertStage({
        workspaceId: context.workspace.id,
        pipelineId: id,
        stageId,
        data,
      })
    }),

  reorderStages: workspaceTokenAuthAPI
    .route({
      method: "PUT",
      path: "/v1/pipelines/{id}/stages/order",
      summary: "Reorder stages",
      description:
        "Sets the column order of the pipeline from the given stage ids; every id must belong to the pipeline.",
      tags: ["Pipelines"],
    })
    .input(reorderStagesPublicRequest)
    .output(z.array(pipelineStagePublicResource))
    .errors(possibleErrorsOnMutatingResource)
    .handler(
      async ({ context, input }) =>
        await pipelineService.reorderStages({
          workspaceId: context.workspace.id,
          pipelineId: input.id,
          stageIds: input.stageIds,
        }),
    ),

  removeStage: workspaceTokenAuthAPI
    .route({
      method: "DELETE",
      path: "/v1/pipelines/{id}/stages/{stageId}",
      summary: "Remove stage",
      description:
        "Removes a stage. Deals still in it are moved to `moveDealsTo` first; without a target and with deals present the call is refused.",
      tags: ["Pipelines"],
    })
    .input(removeStagePublicRequest)
    .output(
      z.object({
        movedDeals: z
          .number()
          .int()
          .describe(
            "How many deals were moved to `moveDealsTo` before the stage was removed.",
          ),
      }),
    )
    .errors(possibleErrorsOnDeletingResource)
    .handler(
      async ({ context, input }) =>
        await pipelineService.removeStage({
          workspaceId: context.workspace.id,
          pipelineId: input.id,
          stageId: input.stageId,
          moveDealsTo: input.moveDealsTo,
        }),
    ),
}
