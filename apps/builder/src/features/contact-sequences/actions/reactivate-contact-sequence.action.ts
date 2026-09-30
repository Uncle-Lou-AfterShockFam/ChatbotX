"use server"

import { contactService } from "@chatbotx.io/business"
import { contactSequenceService } from "@chatbotx.io/business/contact-sequence"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { workspaceIdrequestParams } from "@/features/common/schema"
import { requireContactPermissionScope } from "@/features/contacts/permissions"
import { workspaceActionClient } from "@/lib/safe-action"

/** s228b: an operator reactivates a contact's ENDED sequence subscription. */
export const reactivateContactSequenceAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(
    z.object({
      contactId: zodBigintAsString(),
      sequenceId: zodBigintAsString(),
      expectedUpdatedAt: z.iso.datetime({ offset: true }),
    }),
  )
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
    const { runAt } = await contactSequenceService.reactivateEnrollment({
      workspaceId,
      contactId: contact.id,
      sequenceId: parsedInput.sequenceId,
      expectedUpdatedAt: new Date(parsedInput.expectedUpdatedAt),
    })
    return { runAt: runAt?.toISOString() ?? null }
  })
