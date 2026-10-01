"use server"

import type { UserModel, WorkspaceModel } from "@chatbotx.io/database/types"
import { workspaceIdrequestParams } from "@/features/common/schema"
import { workspaceActionClient } from "@/lib/safe-action"
import { createMarketingMessage } from "../lib/create-marketing-message"
import {
  type CreateMarketingMessageInput,
  createMarketingMessageSchema,
} from "../schema/resource"

// Only the safe-action wrapper lives here: every export of a "use server"
// file is a Server Action, and the helper behind it skips this wrapper's
// input parse and auth, so it stays in a server-only lib module (s232a).
export const createMarketingMessageAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(createMarketingMessageSchema)
  .action(
    async ({
      ctx,
      parsedInput,
    }: {
      ctx: { user: UserModel; workspace: WorkspaceModel }
      parsedInput: CreateMarketingMessageInput
    }) =>
      await createMarketingMessage({
        workspace: ctx.workspace,
        input: parsedInput,
      }),
  )
