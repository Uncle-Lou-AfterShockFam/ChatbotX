"use server"

import { dealService } from "@chatbotx.io/business/deal"
import type { PermissionsInput } from "@chatbotx.io/business/workspace-member/permissions"
import { zodBigintAsString } from "@chatbotx.io/utils"
import type z from "zod"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import {
  requireContactsSectionAccess,
  workspaceActionClient,
} from "@/lib/safe-action"
import { viewerFromActionCtx } from "../lib/viewer"
import { addDealNoteRequest } from "../schema/action"

const input = addDealNoteRequest.extend({ id: zodBigintAsString() })

export const addDealNoteAction = workspaceActionClient
  .use(requireContactsSectionAccess)
  .inputSchema(input)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
      ctx,
    }: {
      parsedInput: z.infer<typeof input>
      bindArgsParsedInputs: WorkspaceIdRequestParams
      ctx: {
        user: { id: string }
        workspaceMemberPermissions: PermissionsInput
      }
    }) =>
      dealService.addNote({
        workspaceId,
        id: parsedInput.id,
        text: parsedInput.text,
        actorId: ctx.user.id,
        viewer: viewerFromActionCtx(ctx),
      }),
  )
