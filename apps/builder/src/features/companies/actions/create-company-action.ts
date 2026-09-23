"use server"

import { companyService } from "@chatbotx.io/business"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { workspaceActionClient } from "@/lib/safe-action"
import {
  type CreateCompanyRequest,
  createCompanyRequest,
} from "../schema/action"

export const createCompanyAction = workspaceActionClient
  .inputSchema(createCompanyRequest)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
    }: {
      parsedInput: CreateCompanyRequest
      bindArgsParsedInputs: WorkspaceIdRequestParams
    }) => companyService.create({ workspaceId, data: parsedInput }),
  )
