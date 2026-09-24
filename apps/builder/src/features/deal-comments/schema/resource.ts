import {
  createSelectSchema,
  dealCommentModel,
} from "@chatbotx.io/database/schema"
import z from "zod"

export const dealCommentMentionRef = z.object({
  userId: z.string(),
  label: z.string(),
})

export const dealCommentResource = createSelectSchema(dealCommentModel, {
  id: z.string(),
  workspaceId: z.string(),
  dealId: z.string(),
  authorId: z.string().nullable(),
  mentions: z.array(dealCommentMentionRef),
})
export type DealCommentResource = z.infer<typeof dealCommentResource>
