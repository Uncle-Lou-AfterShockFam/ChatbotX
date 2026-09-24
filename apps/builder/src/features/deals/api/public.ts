import { dealService } from "@chatbotx.io/business/deal"
import { notFoundException } from "@chatbotx.io/business/errors"
import { z } from "zod"
import {
  possibleErrorsOnCreatingResource,
  possibleErrorsOnDeletingResource,
  possibleErrorsOnFindingResource,
  possibleErrorsOnListingResource,
  possibleErrorsOnMutatingResource,
} from "@/lib/orpc/orpc-error-helper"
import { workspaceTokenAuthAPIForScope } from "@/orpc"
import {
  addDealNotePublicRequest,
  createDealPublicRequest,
  dealActivityPublicResource,
  dealIdInput,
  dealPublicResource,
  listDealsPublicRequest,
  listDealsPublicResponse,
  moveDealPipelinePublicRequest,
  moveDealPublicRequest,
  setDealStatusPublicRequest,
  updateDealPublicRequest,
} from "../schema/public"

const workspaceTokenAuthAPI = workspaceTokenAuthAPIForScope("deals")

export const dealsPublicRouter = {
  list: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/deals",
      summary: "List deals",
      description:
        "Returns deals in this workspace, newest first, filtered by pipeline, stage, contact, company, owner, status or title. Returns `{ data, pageCount }`; page with `page`/`perPage`.",
      tags: ["Deals"],
    })
    .input(listDealsPublicRequest)
    .output(listDealsPublicResponse)
    .errors(possibleErrorsOnListingResource)
    .handler(
      async ({ context, input }) =>
        await dealService.list({ ...input, workspaceId: context.workspace.id }),
    ),

  get: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/deals/{id}",
      summary: "Get deal",
      description: "Returns one deal. Use `deals.list` to find its id.",
      tags: ["Deals"],
    })
    .input(dealIdInput)
    .output(dealPublicResource)
    .errors(possibleErrorsOnFindingResource)
    .handler(
      async ({ context, input }) =>
        await dealService.findOrFail({
          workspaceId: context.workspace.id,
          id: input.id,
        }),
    ),

  listActivities: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/deals/{id}/activities",
      summary: "List deal activities",
      description:
        "Returns the activity log of a deal, newest first: creation, stage moves, value / status / priority / owner changes and notes.",
      tags: ["Deals"],
    })
    .input(dealIdInput)
    .output(z.object({ data: z.array(dealActivityPublicResource) }))
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => ({
      data: await dealService.listActivities({
        workspaceId: context.workspace.id,
        dealId: input.id,
      }),
    })),

  create: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/deals",
      summary: "Create deal",
      description:
        "Opens a deal in a pipeline. Emits the `ticketCreated` trigger event for the deal contact and, when the pipeline says `stopCompanyOn: created`, stops the contact's company.",
      successStatus: 201,
      tags: ["Deals"],
    })
    .input(createDealPublicRequest)
    .output(dealPublicResource)
    .errors(possibleErrorsOnCreatingResource)
    .handler(
      async ({ context, input }) =>
        await dealService.create({
          workspaceId: context.workspace.id,
          data: input,
        }),
    ),

  update: workspaceTokenAuthAPI
    .route({
      method: "PATCH",
      path: "/v1/deals/{id}",
      summary: "Update deal",
      description:
        "Merges the given fields into a deal: title, value, currency, priority, owner, due date or extra fields. A changed value or priority emits its trigger event.",
      tags: ["Deals"],
    })
    .input(updateDealPublicRequest)
    .output(dealPublicResource)
    .errors(possibleErrorsOnMutatingResource)
    .handler(async ({ context, input }) => {
      const { id, ...data } = input
      return await dealService.update({
        workspaceId: context.workspace.id,
        id,
        data,
      })
    }),

  move: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/deals/{id}/move",
      summary: "Move deal to stage",
      description:
        "Moves a deal to a stage of its pipeline and emits `ticketMovedToStage`. Landing on a won or lost stage also closes the deal with that status.",
      tags: ["Deals"],
    })
    .input(moveDealPublicRequest)
    .output(dealPublicResource)
    .errors(possibleErrorsOnMutatingResource)
    .handler(
      async ({ context, input }) =>
        await dealService.moveStage({
          workspaceId: context.workspace.id,
          id: input.id,
          stageId: input.stageId,
          position: input.position,
        }),
    ),

  movePipeline: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/deals/{id}/move-pipeline",
      summary: "Move deal to another pipeline",
      description:
        "Moves a deal to a stage of ANOTHER pipeline (default: its first stage) and emits `ticketMovedToStage` with `fromPipelineId`. The deal's fields must satisfy the destination's required fields (`fields` supplies missing ones); an owner who cannot see a members-only destination must be replaced (`ownerId`). A contact with an open deal already in the destination is refused. Tasks, comments and activity stay with the deal; the destination stage's task templates run.",
      tags: ["Deals"],
    })
    .input(moveDealPipelinePublicRequest)
    .output(dealPublicResource)
    .errors(possibleErrorsOnMutatingResource)
    .handler(
      async ({ context, input }) =>
        await dealService.movePipeline({
          workspaceId: context.workspace.id,
          id: input.id,
          pipelineId: input.pipelineId,
          stageId: input.stageId,
          fields: input.fields,
          ownerId: input.ownerId,
        }),
    ),

  setStatus: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/deals/{id}/status",
      summary: "Set deal status",
      description:
        "Marks a deal open, won or lost and emits `ticketStatusChanged`. Won can stop the contact's company when the pipeline says `stopCompanyOn: won`. Same status = no change.",
      tags: ["Deals"],
    })
    .input(setDealStatusPublicRequest)
    .output(dealPublicResource)
    .errors(possibleErrorsOnMutatingResource)
    .handler(
      async ({ context, input }) =>
        await dealService.setStatus({
          workspaceId: context.workspace.id,
          id: input.id,
          status: input.status,
        }),
    ),

  addNote: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/deals/{id}/notes",
      summary: "Add deal note",
      description: "Appends a free-text note to the deal's activity log.",
      successStatus: 201,
      tags: ["Deals"],
    })
    .input(addDealNotePublicRequest)
    .output(dealActivityPublicResource)
    .errors(possibleErrorsOnMutatingResource)
    .handler(
      async ({ context, input }) =>
        await dealService.addNote({
          workspaceId: context.workspace.id,
          id: input.id,
          text: input.text,
        }),
    ),

  delete: workspaceTokenAuthAPI
    .route({
      method: "DELETE",
      path: "/v1/deals/{id}",
      summary: "Delete deal",
      description:
        "Removes a deal permanently together with its activity log; the contact, company and pipeline are kept.",
      tags: ["Deals"],
      successStatus: 204,
    })
    .input(dealIdInput)
    .errors(possibleErrorsOnDeletingResource)
    .handler(async ({ context, input }) => {
      const { deletedCount } = await dealService.remove({
        workspaceId: context.workspace.id,
        ids: [input.id],
      })
      if (deletedCount === 0) {
        throw notFoundException("Deal not found")
      }
    }),
}
