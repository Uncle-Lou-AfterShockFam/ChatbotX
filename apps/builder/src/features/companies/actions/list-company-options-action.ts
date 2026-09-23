"use server"

import { companyService } from "@chatbotx.io/business"
import z from "zod"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { workspaceActionClient } from "@/lib/safe-action"

/** Up to 200 companies as picker options, optionally filtered by name. */
export const listCompanyOptionsAction = workspaceActionClient
  .inputSchema(z.object({ name: z.string().trim().max(255).optional() }))
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
    }: {
      parsedInput: { name?: string }
      bindArgsParsedInputs: WorkspaceIdRequestParams
    }) => {
      const { data } = await companyService.list({
        workspaceId,
        name: parsedInput.name || null,
        page: 1,
        perPage: 200,
      })
      return data.map((company) => ({
        value: company.id,
        label: company.name,
        stopped: company.stoppedAt !== null,
      }))
    },
  )
