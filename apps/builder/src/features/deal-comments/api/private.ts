import { dealCommentService } from "@chatbotx.io/business/deal-comment"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"
import { viewerFromContext } from "@/features/deals/lib/viewer"
import { withWorkspaceIdSchema } from "@/features/workspaces/schema/resource"
import { contactsAccessAuthorizedMiddleware } from "@/middlewares/auth"
import { authorizedAPI } from "@/orpc"
import {
  createDealCommentRequest,
  updateDealCommentRequest,
} from "../schema/action"
import { dealCommentResource } from "../schema/resource"

const withDealId = withWorkspaceIdSchema.and(
  z.object({ id: zodBigintAsString() }),
)
const withCommentId = withDealId.and(
  z.object({ commentId: zodBigintAsString() }),
)

const privateListDealCommentsAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/deals/{id}/comments",
    summary: "Comments of a deal, newest first",
    tags: ["Deals"],
  })
  .input(withDealId)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ data: z.array(dealCommentResource) }))
  .handler(async ({ input, context }) => ({
    data: await dealCommentService.list({
      workspaceId: input.workspaceId,
      dealId: input.id,
      viewer: viewerFromContext(context),
    }),
  }))

const privateCreateDealCommentAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/deals/{id}/comments",
    summary: "Comment on a deal (with @mentions)",
    tags: ["Deals"],
  })
  .input(createDealCommentRequest.and(withDealId))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(dealCommentResource)
  .handler(
    async ({ input, context }) =>
      await dealCommentService.create({
        workspaceId: input.workspaceId,
        dealId: input.id,
        body: input.body,
        actorId: context.user.id,
        viewer: viewerFromContext(context),
      }),
  )

const privateUpdateDealCommentAPI = authorizedAPI
  .route({
    method: "PUT",
    path: "/workspaces/{workspaceId}/deals/{id}/comments/{commentId}",
    summary: "Edit a comment",
    tags: ["Deals"],
  })
  .input(updateDealCommentRequest.and(withCommentId))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(dealCommentResource)
  .handler(
    async ({ input, context }) =>
      await dealCommentService.update({
        workspaceId: input.workspaceId,
        dealId: input.id,
        commentId: input.commentId,
        body: input.body,
        actorId: context.user.id,
        viewer: viewerFromContext(context),
      }),
  )

const privateDeleteDealCommentAPI = authorizedAPI
  .route({
    method: "DELETE",
    path: "/workspaces/{workspaceId}/deals/{id}/comments/{commentId}",
    summary: "Delete a comment",
    tags: ["Deals"],
  })
  .input(withCommentId)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ deleted: z.literal(true) }))
  .handler(async ({ input, context }) => {
    await dealCommentService.remove({
      workspaceId: input.workspaceId,
      dealId: input.id,
      commentId: input.commentId,
      actorId: context.user.id,
      viewer: viewerFromContext(context),
    })
    return { deleted: true as const }
  })

const privateMarkMentionReadAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/deals/{id}/comments/{commentId}/read",
    summary: "Mark my mention on a comment read",
    tags: ["Deals"],
  })
  .input(withCommentId)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ marked: z.boolean() }))
  .handler(async ({ input, context }) => {
    await dealCommentService.findOrFail({
      workspaceId: input.workspaceId,
      dealId: input.id,
      commentId: input.commentId,
      viewer: viewerFromContext(context),
    })
    return await dealCommentService.markMentionRead({
      workspaceId: input.workspaceId,
      commentId: input.commentId,
      userId: context.user.id,
    })
  })

export const privateDealCommentsAPI = {
  privateListDealCommentsAPI,
  privateCreateDealCommentAPI,
  privateUpdateDealCommentAPI,
  privateDeleteDealCommentAPI,
  privateMarkMentionReadAPI,
}
