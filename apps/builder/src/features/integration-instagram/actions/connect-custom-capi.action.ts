"use server"

import {
  instagramIntegrationService,
  metaConversionsService,
} from "@chatbotx.io/business"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import { getDataset } from "@chatbotx.io/integration-meta-conversions"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { getTranslations } from "next-intl/server"
import { z } from "zod"
import { settingsActionClient } from "@/lib/safe-action"

export const connectInstagramCustomCapiAction = settingsActionClient
  .inputSchema(
    z.object({
      datasetId: z.string().trim().min(1),
      accessToken: z.string().trim().min(1),
    }),
  )
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId, integrationId],
    }: {
      parsedInput: { datasetId: string; accessToken: string }
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
        await metaConversionsService.connectCustomCapi({
          channel: "instagram",
          integration,
          accessToken: parsedInput.accessToken,
          datasetId: parsedInput.datasetId,
          validate: getDataset,
        })
      } catch {
        throw new ChatbotXException(t("invalidToken"))
      }

      return { success: true }
    },
  )
