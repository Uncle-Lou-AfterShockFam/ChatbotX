import { dealService } from "@chatbotx.io/business/deal"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"
import { withWorkspaceIdSchema } from "@/features/workspaces/schema/resource"
import { contactsAccessAuthorizedMiddleware } from "@/middlewares/auth"
import { authorizedAPI } from "@/orpc"
import {
  addDealNoteRequest,
  createDealRequest,
  deleteDealsRequest,
  moveDealRequest,
  setDealStatusRequest,
  updateDealRequest,
} from "../schema/action"
import {
  boardStatusFilter,
  listDealsRequest,
  listDealsResponse,
} from "../schema/query"
import {
  boardColumnResource,
  dealActivityResource,
  dealResource,
} from "../schema/resource"

const withDealId = withWorkspaceIdSchema.and(
  z.object({ id: zodBigintAsString() }),
)

const privateListWorkspaceDealsAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/deals",
    summary: "List deals",
    tags: ["Deals"],
  })
  .input(listDealsRequest.and(withWorkspaceIdSchema))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(listDealsResponse)
  .handler(async ({ input }) => await dealService.list(input))

const privateGetDealBoardAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/pipelines/{pipelineId}/board",
    summary: "Deals of a pipeline grouped by stage",
    tags: ["Deals"],
  })
  .input(
    withWorkspaceIdSchema.and(
      z.object({
        pipelineId: zodBigintAsString(),
        status: boardStatusFilter.optional(),
      }),
    ),
  )
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ data: z.array(boardColumnResource) }))
  .handler(async ({ input }) => ({
    data: await dealService.listBoard(input),
  }))

const privateGetDealAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/deals/{id}",
    summary: "Get a deal",
    tags: ["Deals"],
  })
  .input(withDealId)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(dealResource)
  .handler(async ({ input }) => await dealService.findOrFail(input))

const privateListDealActivitiesAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/deals/{id}/activities",
    summary: "Activity log of a deal",
    tags: ["Deals"],
  })
  .input(withDealId)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ data: z.array(dealActivityResource) }))
  .handler(async ({ input }) => ({
    data: await dealService.listActivities({
      workspaceId: input.workspaceId,
      dealId: input.id,
    }),
  }))

const privateCreateDealAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/deals",
    summary: "Create a deal",
    tags: ["Deals"],
  })
  .input(createDealRequest.and(withWorkspaceIdSchema))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(dealResource)
  .handler(async ({ input, context }) => {
    const { workspaceId, ...data } = input
    return await dealService.create({
      workspaceId,
      data,
      actorId: context.user.id,
    })
  })

const privateUpdateDealAPI = authorizedAPI
  .route({
    method: "PUT",
    path: "/workspaces/{workspaceId}/deals/{id}",
    summary: "Update a deal",
    tags: ["Deals"],
  })
  .input(updateDealRequest.and(withDealId))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(dealResource)
  .handler(async ({ input, context }) => {
    const { workspaceId, id, ...data } = input
    return await dealService.update({
      workspaceId,
      id,
      data,
      actorId: context.user.id,
    })
  })

const privateMoveDealAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/deals/{id}/move",
    summary: "Move a deal to a stage",
    tags: ["Deals"],
  })
  .input(moveDealRequest.and(withDealId))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(dealResource)
  .handler(async ({ input, context }) => {
    const { workspaceId, id, stageId, position } = input
    return await dealService.moveStage({
      workspaceId,
      id,
      stageId,
      position,
      actorId: context.user.id,
    })
  })

const privateSetDealStatusAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/deals/{id}/status",
    summary: "Mark a deal open, won or lost",
    tags: ["Deals"],
  })
  .input(setDealStatusRequest.and(withDealId))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(dealResource)
  .handler(async ({ input, context }) => {
    const { workspaceId, id, status } = input
    return await dealService.setStatus({
      workspaceId,
      id,
      status,
      actorId: context.user.id,
    })
  })

const privateAddDealNoteAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/deals/{id}/notes",
    summary: "Add a note to a deal",
    tags: ["Deals"],
  })
  .input(addDealNoteRequest.and(withDealId))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(dealActivityResource)
  .handler(async ({ input, context }) => {
    const { workspaceId, id, text } = input
    return await dealService.addNote({
      workspaceId,
      id,
      text,
      actorId: context.user.id,
    })
  })

const privateDeleteDealsAPI = authorizedAPI
  .route({
    method: "DELETE",
    path: "/workspaces/{workspaceId}/deals",
    summary: "Delete deals",
    tags: ["Deals"],
  })
  .input(deleteDealsRequest.and(withWorkspaceIdSchema))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ deletedCount: z.number().int() }))
  .handler(async ({ input }) => await dealService.remove(input))

export const privateDealsAPI = {
  privateListWorkspaceDealsAPI,
  privateGetDealBoardAPI,
  privateGetDealAPI,
  privateListDealActivitiesAPI,
  privateCreateDealAPI,
  privateUpdateDealAPI,
  privateMoveDealAPI,
  privateSetDealStatusAPI,
  privateAddDealNoteAPI,
  privateDeleteDealsAPI,
}
