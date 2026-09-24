"use server"

import { dealCommentService } from "@chatbotx.io/business/deal-comment"
import type { PermissionsInput } from "@chatbotx.io/business/workspace-member/permissions"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { viewerFromActionCtx } from "@/features/deals/lib/viewer"
import {
  requireContactsSectionAccess,
  workspaceActionClient,
} from "@/lib/safe-action"
import {
  createDealCommentRequest,
  updateDealCommentRequest,
} from "../schema/action"

type Ctx = {
  user: { id: string }
  workspaceMemberPermissions: PermissionsInput
}
type Bound = { bindArgsParsedInputs: WorkspaceIdRequestParams; ctx: Ctx }

const createInput = createDealCommentRequest.extend({
  dealId: zodBigintAsString(),
})
export const createDealCommentAction = workspaceActionClient
  .use(requireContactsSectionAccess)
  .inputSchema(createInput)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
      ctx,
    }: Bound & { parsedInput: z.infer<typeof createInput> }) =>
      dealCommentService.create({
        workspaceId,
        dealId: parsedInput.dealId,
        body: parsedInput.body,
        actorId: ctx.user.id,
        viewer: viewerFromActionCtx(ctx),
      }),
  )

const updateInput = updateDealCommentRequest.extend({
  dealId: zodBigintAsString(),
  commentId: zodBigintAsString(),
})
export const updateDealCommentAction = workspaceActionClient
  .use(requireContactsSectionAccess)
  .inputSchema(updateInput)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
      ctx,
    }: Bound & { parsedInput: z.infer<typeof updateInput> }) =>
      dealCommentService.update({
        workspaceId,
        dealId: parsedInput.dealId,
        commentId: parsedInput.commentId,
        body: parsedInput.body,
        actorId: ctx.user.id,
        viewer: viewerFromActionCtx(ctx),
      }),
  )

const deleteInput = z.object({
  dealId: zodBigintAsString(),
  commentId: zodBigintAsString(),
})
export const deleteDealCommentAction = workspaceActionClient
  .use(requireContactsSectionAccess)
  .inputSchema(deleteInput)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
      ctx,
    }: Bound & { parsedInput: z.infer<typeof deleteInput> }) => {
      await dealCommentService.remove({
        workspaceId,
        dealId: parsedInput.dealId,
        commentId: parsedInput.commentId,
        actorId: ctx.user.id,
        viewer: viewerFromActionCtx(ctx),
      })
      return { deleted: true as const }
    },
  )
