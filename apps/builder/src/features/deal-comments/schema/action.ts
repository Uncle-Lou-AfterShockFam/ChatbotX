import { MAX_DEAL_COMMENT_CHARS } from "@chatbotx.io/database/partials"
import z from "zod"

const body = z
  .string()
  .trim()
  .min(1)
  .max(MAX_DEAL_COMMENT_CHARS)
  .describe(
    "Comment text (max 4000 characters). Mention a teammate with `@[Label](u:<userId>)`; every mentioned user must be a workspace member (and a pipeline member on a members-only pipeline).",
  )

export const createDealCommentRequest = z.object({ body })
export type CreateDealCommentRequest = z.infer<typeof createDealCommentRequest>

export const updateDealCommentRequest = z.object({ body })
export type UpdateDealCommentRequest = z.infer<typeof updateDealCommentRequest>
