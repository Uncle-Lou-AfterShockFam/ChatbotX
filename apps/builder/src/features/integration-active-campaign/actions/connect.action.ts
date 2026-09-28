"use server"

import { integrationActiveCampaignService } from "@chatbotx.io/business"
import {
  ActiveCampaignApiError,
  integration as activeCampaignIntegration,
} from "@chatbotx.io/integration-active-campaign"
import { SdkException } from "@chatbotx.io/sdk"
import { SsrfFetchError } from "@chatbotx.io/sdk/outbound-fetch"
import { getTranslations } from "next-intl/server"
import { normalizeError } from "universal-error-normalizer"
import { workspaceIdrequestParams } from "@/features/common/schema"
import { logger } from "@/lib/log"
import { workspaceActionClient } from "@/lib/safe-action"
import { connectActiveCampaignSchema } from "../schema"

export const connectActiveCampaignAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(connectActiveCampaignSchema)
  .action(async ({ bindArgsParsedInputs: [workspaceId], parsedInput }) => {
    try {
      const auth = await activeCampaignIntegration.runAction(
        "validateCredentials",
        { props: parsedInput },
      )
      await integrationActiveCampaignService.upsert({ workspaceId, auth })
    } catch (error) {
      logger.error(
        { err: normalizeError(error), workspaceId },
        "Failed to connect ActiveCampaign",
      )
      if (error instanceof ActiveCampaignApiError) {
        const t = await getTranslations("activeCampaign.errors")
        throw new SdkException(t("invalidCredentials"), 400, 400)
      }
      // The pinned outbound fetch refused the API URL (a private / internal
      // address, or a redirect): say so, not a generic server error (s219).
      if (error instanceof SsrfFetchError) {
        const t = await getTranslations("activeCampaign.errors")
        throw new SdkException(t("unreachableApiUrl"), 400, 400)
      }
      throw error
    }
  })
