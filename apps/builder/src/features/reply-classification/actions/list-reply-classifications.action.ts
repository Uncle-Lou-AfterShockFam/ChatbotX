"use server"

import { contactService } from "@chatbotx.io/business"
import { replyClassificationService } from "@chatbotx.io/business/reply-classification"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { workspaceIdrequestParams } from "@/features/common/schema"
import { requireContactPermissionScope } from "@/features/contacts/permissions"
import { workspaceActionClient } from "@/lib/safe-action"
import { toClassificationResource } from "../schema/public"

/** s228b: the contact's latest classifications, newest first. */
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
