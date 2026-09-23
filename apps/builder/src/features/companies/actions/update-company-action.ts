"use server"

import { companyService } from "@chatbotx.io/business"
import { zodBigintAsString } from "@chatbotx.io/utils"
import type z from "zod"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { workspaceActionClient } from "@/lib/safe-action"
import { updateCompanyRequest } from "../schema/action"

const input = updateCompanyRequest.extend({ id: zodBigintAsString() })

export const updateCompanyAction = workspaceActionClient
  .inputSchema(input)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
    }: {
      parsedInput: z.infer<typeof input>
      bindArgsParsedInputs: WorkspaceIdRequestParams
    }) => {
      const { id, ...data } = parsedInput
      return await companyService.update({ workspaceId, id, data })
    },
  )
