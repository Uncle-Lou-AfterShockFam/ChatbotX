"use server"

import { stopCompany } from "@chatbotx.io/business/company-stop"
import { zodBigintAsString } from "@chatbotx.io/utils"
import type z from "zod"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { workspaceActionClient } from "@/lib/safe-action"
import { stopCompanyRequest } from "../schema/action"

const input = stopCompanyRequest.extend({ id: zodBigintAsString() })

export const stopCompanyAction = workspaceActionClient
  .inputSchema(input)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
    }: {
      parsedInput: z.infer<typeof input>
      bindArgsParsedInputs: WorkspaceIdRequestParams
    }) =>
      stopCompany({
        workspaceId,
        companyId: parsedInput.id,
        reason: "api",
        force: parsedInput.force,
      }),
  )
