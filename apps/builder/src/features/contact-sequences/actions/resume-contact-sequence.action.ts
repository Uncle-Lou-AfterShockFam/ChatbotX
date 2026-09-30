"use server"

import { contactService } from "@chatbotx.io/business"
import { contactSequenceService } from "@chatbotx.io/business/contact-sequence"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { workspaceIdrequestParams } from "@/features/common/schema"
import { requireContactPermissionScope } from "@/features/contacts/permissions"
import { workspaceActionClient } from "@/lib/safe-action"

/** s227b: an operator resumes a contact HELD at a sequence step. */
export const resumeContactSequenceAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(
    z.object({
      contactId: zodBigintAsString(),
      sequenceId: zodBigintAsString(),
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
    const { runAt } = await contactSequenceService.resumeHeldEnrollment({
      workspaceId,
      contactId: contact.id,
      sequenceId: parsedInput.sequenceId,
    })
    return { runAt: runAt.toISOString() }
  })
