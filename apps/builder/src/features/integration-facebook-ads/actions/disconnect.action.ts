"use server"

import { integrationFacebookAdsService } from "@chatbotx.io/business"
import { encryptedDataSchema, encryptUtils } from "@chatbotx.io/encryption"
import {
  facebookAdsAuthSchema,
  integration as integrationFacebookAds,
} from "@chatbotx.io/integration-facebook-ads"
import { workspaceIdrequestParams } from "@/features/common/schema"
import { logger } from "@/lib/log"
import { settingsActionClient } from "@/lib/safe-action"

export const disconnectFacebookAdsAction = settingsActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId],
    }: {
      bindArgsParsedInputs: [string]
    }) => {
      const row =
        await integrationFacebookAdsService.findByWorkspaceIdOrFail(workspaceId)

      try {
        const auth = await encryptUtils.decryptObject(
          encryptedDataSchema.parse(row.auth),
          facebookAdsAuthSchema,
        )
        await integrationFacebookAds.disconnect?.(auth)
      } catch (e) {
        logger.error(
          e,
          `Unable to revoke Facebook Ads token for workspace: ${workspaceId}`,
        )
      }

      await integrationFacebookAdsService.disconnect(workspaceId)
      return
    },
  )
