"use server"

import {
  instagramIntegrationService,
  metaConversionsService,
} from "@chatbotx.io/business"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import {
  buildDatasetName,
  ensureDataset,
} from "@chatbotx.io/integration-meta-conversions"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { getTranslations } from "next-intl/server"
import { surfaceCapiError } from "@/features/meta-conversions/lib/surface-capi-error"
import { settingsActionClient } from "@/lib/safe-action"

export const provisionInstagramCapiDatasetAction = settingsActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, integrationId],
    }: {
      bindArgsParsedInputs: readonly [string, string]
    }) => {
      const t = await getTranslations("metaConversions.errors")

      const integration =
        await instagramIntegrationService.findByIdForWorkspace({
          id: integrationId,
          workspaceId,
        })
      if (integration?.type !== "facebook") {
        throw new ChatbotXException(t("instagramNotFound"))
      }

      try {
        await metaConversionsService.provisionDatasetNow({
          channel: "instagram",
          integration,
          provisionDataset: ({ accessToken, resourceId, resourceName }) =>
            ensureDataset({
              resourceType: "igUser",
              resourceId,
              accessToken,
              datasetName: buildDatasetName(resourceName),
            }),
        })
      } catch (error) {
        surfaceCapiError(error)
      }

      // Save = connect: clear a user-intent disconnect so this is the only
      // path back from a Disconnect now that OAuth reconnect is gone.
      await metaConversionsService.reconnectCapi({
        channel: "instagram",
        integration,
      })

      return { success: true }
    },
  )
