import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"
import { dealCommentResource } from "./resource"

export const dealCommentPublicResource = dealCommentResource.omit({
  workspaceId: true,
})

export const dealIdParam = z.object({
  id: zodBigintAsString().describe("Deal id. Get it from `deals.list`."),
})
export const dealCommentIdParams = dealIdParam.extend({
  commentId: zodBigintAsString().describe(
    "Comment id. Get it from `deals.listComments`.",
  ),
})
