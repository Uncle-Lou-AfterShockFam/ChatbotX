"use server"

import type { UserModel, WorkspaceModel } from "@chatbotx.io/database/types"
import { workspaceIdrequestParams } from "@/features/common/schema"
import { settingsActionClient } from "@/lib/safe-action"
import { buildFacebookAdsAuthRedirect } from "./connect-redirect"

export const connectFacebookAds = settingsActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    ({
      ctx,
    }: {
      ctx: {
        user: UserModel
        workspace: WorkspaceModel
      }
    }) =>
      buildFacebookAdsAuthRedirect({
        workspace: ctx.workspace,
        refererPath: `/space/${ctx.workspace.id}/settings/integrations`,
      }),
  )
