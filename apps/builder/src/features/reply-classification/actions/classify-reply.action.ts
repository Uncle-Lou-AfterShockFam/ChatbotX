"use server"

import { contactService } from "@chatbotx.io/business"
import { replyClassificationService } from "@chatbotx.io/business/reply-classification"
import {
  MAX_REPLY_REASON,
  replyClassManualClasses,
} from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { workspaceIdrequestParams } from "@/features/common/schema"
import { requireContactPermissionScope } from "@/features/contacts/permissions"
import { viewerFromActionCtx } from "@/features/deals/lib/viewer"
import { workspaceActionClient } from "@/lib/safe-action"
import { toClassificationResource } from "../schema/public"

/**
 * s228b: an operator classifies a contact's answer to outreach. The deal it
 * opens or moves is scoped to the operator (s193 pipeline access).
 */
export const classifyReplyAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(
    z.object({
      contactId: zodBigintAsString(),
      class: replyClassManualClasses,
      reason: z.string().max(MAX_REPLY_REASON).optional(),
      sequenceId: zodBigintAsString().optional(),
    }),
  )
  .action(async (props) => {
    const {
      bindArgsParsedInputs: [workspaceId],
      parsedInput,
      ctx,
    } = props
    const accessScope = await requireContactPermissionScope(workspaceId)
    const contact = await contactService.findByIdOrFail({
      workspaceId,
      id: parsedInput.contactId,
      accessScope,
    })
    const { classification } = await replyClassificationService.classifyReply({
      workspaceId,
      contactId: contact.id,
      class: parsedInput.class,
      source: "manual",
      reason: parsedInput.reason ?? null,
      sequenceId: parsedInput.sequenceId ?? null,
      actorId: ctx.user.id,
      viewer: viewerFromActionCtx(ctx),
    })
    return classification ? toClassificationResource(classification) : null
  })
