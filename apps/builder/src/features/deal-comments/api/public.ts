import { dealCommentService } from "@chatbotx.io/business/deal-comment"
import { z } from "zod"
import {
  possibleErrorsOnCreatingResource,
  possibleErrorsOnDeletingResource,
  possibleErrorsOnFindingResource,
  possibleErrorsOnMutatingResource,
} from "@/lib/orpc/orpc-error-helper"
import { workspaceTokenAuthAPIForScope } from "@/orpc"
import {
  createDealCommentRequest,
  updateDealCommentRequest,
} from "../schema/action"
import {
  dealCommentIdParams,
  dealCommentPublicResource,
  dealIdParam,
} from "../schema/public"

const workspaceTokenAuthAPI = workspaceTokenAuthAPIForScope("deals")

/** Mounted under `deals` in routers/public.ts. */
export const dealCommentsPublicRouter = {
  listComments: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/deals/{id}/comments",
      summary: "List deal comments",
      description:
        "Returns the comments of a deal, newest first (at most 100), each with its parsed `mentions` (userId + label) next to the raw `body`.",
      tags: ["Deals"],
    })
    .input(dealIdParam)
    .output(z.object({ data: z.array(dealCommentPublicResource) }))
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => ({
      data: await dealCommentService.list({
        workspaceId: context.workspace.id,
        dealId: input.id,
      }),
    })),

  createComment: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/deals/{id}/comments",
      summary: "Comment on deal",
      description:
        "Adds a comment to a deal (at most 1000 per deal, 20 mentions each). Every `@[Label](u:<userId>)` token must name a workspace member; each one emits `dealMentioned` for the deal contact.",
      successStatus: 201,
      tags: ["Deals"],
    })
    .input(createDealCommentRequest.and(dealIdParam))
    .output(dealCommentPublicResource)
    .errors(possibleErrorsOnCreatingResource)
    .handler(
      async ({ context, input }) =>
        await dealCommentService.create({
          workspaceId: context.workspace.id,
          dealId: input.id,
          body: input.body,
        }),
    ),

  updateComment: workspaceTokenAuthAPI
    .route({
      method: "PUT",
      path: "/v1/deals/{id}/comments/{commentId}",
      summary: "Edit deal comment",
      description:
        "Replaces the body of a comment. Mentions added by the edit are recorded and emitted; earlier mentions are kept even when their token is gone.",
      tags: ["Deals"],
    })
    .input(updateDealCommentRequest.and(dealCommentIdParams))
    .output(dealCommentPublicResource)
    .errors(possibleErrorsOnMutatingResource)
    .handler(
      async ({ context, input }) =>
        await dealCommentService.update({
          workspaceId: context.workspace.id,
          dealId: input.id,
          commentId: input.commentId,
          body: input.body,
        }),
    ),

  deleteComment: workspaceTokenAuthAPI
    .route({
      method: "DELETE",
      path: "/v1/deals/{id}/comments/{commentId}",
      summary: "Delete deal comment",
      description:
        "Deletes a comment and its mention records. The `commented` activity line of the deal stays as history.",
      successStatus: 204,
      tags: ["Deals"],
    })
    .input(dealCommentIdParams)
    .output(z.void())
    .errors(possibleErrorsOnDeletingResource)
    .handler(async ({ context, input }) => {
      await dealCommentService.remove({
        workspaceId: context.workspace.id,
        dealId: input.id,
        commentId: input.commentId,
      })
    }),
}
