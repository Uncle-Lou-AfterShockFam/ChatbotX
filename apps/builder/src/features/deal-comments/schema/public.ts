import { zodBigintAsString } from "@chatbotx.io/utils"
import { dealIdParam } from "@/features/deals/schema/public-params"
import { dealCommentResource } from "./resource"

export const dealCommentPublicResource = dealCommentResource.omit({
  workspaceId: true,
})

export const dealCommentIdParams = dealIdParam.extend({
  commentId: zodBigintAsString().describe(
    "Comment id. Get it from `deals.listComments`.",
  ),
})

export { dealIdParam } from "@/features/deals/schema/public-params"
