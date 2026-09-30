"use server"

import { contactService } from "@chatbotx.io/business"
import { replyClassificationService } from "@chatbotx.io/business/reply-classification"
import { replyClassManualClasses } from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { workspaceIdrequestParams } from "@/features/common/schema"
import { requireContactPermissionScope } from "@/features/contacts/permissions"
import { workspaceActionClient } from "@/lib/safe-action"
import { toClassificationResource } from "../schema/public"

/** s228b: an operator classifies a contact's answer to outreach. */
export const classifyReplyAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(
    z.object({
      contactId: zodBigintAsString(),
      class: replyClassManualClasses,
      reason: z.string().max(300).optional(),
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
      actorId: ctx.user.id,
    })
    return classification ? toClassificationResource(classification) : null
  })

/** s228b: the contact's classifications, newest first. */
export const listReplyClassificationsAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(z.object({ contactId: zodBigintAsString() }))
  .action(async (props) => {
    const {
      bindArgsParsedInputs: [workspaceId],
      parsedInput,
    } = props
    const accessScope = await requireContactPermissionScope(workspaceId)
    const contact = await contactService.findByIdOrFail({
      workspaceId,
      id: parsedInput.contactId,
      accessScope,
    })
    const rows = await replyClassificationService.listByContact({
      workspaceId,
      contactId: contact.id,
      limit: 5,
    })
    return rows.map(toClassificationResource)
  })
