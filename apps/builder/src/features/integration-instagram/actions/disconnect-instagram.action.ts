"use server"

import {
  type WorkspaceIdAndIdRequestParams,
  workspaceIdAndIdRequestParams,
} from "@/features/common/schema"
import { settingsActionClientAllowExpired } from "@/lib/safe-action"
import { disconnectInstagram } from "./disconnect-instagram"

export const disconnectInstagramAction = settingsActionClientAllowExpired
  .bindArgsSchemas(workspaceIdAndIdRequestParams)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, integrationInstagramId],
    }: {
      bindArgsParsedInputs: WorkspaceIdAndIdRequestParams
    }) => {
      await disconnectInstagram({ workspaceId, integrationInstagramId })
    },
  )
