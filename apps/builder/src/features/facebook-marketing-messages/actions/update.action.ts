"use server"

import type { UserModel, WorkspaceModel } from "@chatbotx.io/database/types"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { workspaceActionClient } from "@/lib/safe-action"
import { updateMarketingMessage } from "../lib/update-marketing-message"
import {
  type UpdateMarketingMessageInput,
  updateMarketingMessageSchema,
} from "../schema/resource"

// Only the safe-action wrapper lives here: every export of a "use server"
// file is a Server Action, and the helper behind it skips this wrapper's
// input parse and auth, so it stays in a server-only lib module (s232a).
export const updateMarketingMessageAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .inputSchema(updateMarketingMessageSchema)
  .action(
    async ({
      ctx,
      bindArgsParsedInputs: [, id],
      parsedInput,
    }: {
      ctx: { user: UserModel; workspace: WorkspaceModel }
      bindArgsParsedInputs: readonly [string, string]
      parsedInput: UpdateMarketingMessageInput
    }) =>
      await updateMarketingMessage({
        workspace: ctx.workspace,
        id,
        input: parsedInput,
      }),
  )
