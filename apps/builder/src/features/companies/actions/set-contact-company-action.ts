"use server"

import { companyService } from "@chatbotx.io/business"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { workspaceActionClient } from "@/lib/safe-action"
import {
  type SetContactCompanyRequest,
  setContactCompanyRequest,
} from "../schema/action"

export const setContactCompanyAction = workspaceActionClient
  .inputSchema(setContactCompanyRequest)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
    }: {
      parsedInput: SetContactCompanyRequest
      bindArgsParsedInputs: WorkspaceIdRequestParams
    }) => {
      await companyService.assignContact({
        workspaceId,
        contactId: parsedInput.contactId,
        companyId: parsedInput.companyId,
      })
    },
  )
