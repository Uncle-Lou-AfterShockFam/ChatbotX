"use server"

import {
  integrationWhatsappService,
  metaConversionsService,
} from "@chatbotx.io/business"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { getTranslations } from "next-intl/server"
import { settingsActionClientAllowExpired } from "@/lib/safe-action"

export const disconnectWhatsappCapiAction = settingsActionClientAllowExpired
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, integrationId],
    }: {
      bindArgsParsedInputs: readonly [string, string]
    }) => {
      const t = await getTranslations("metaConversions.errors")

      const integration = await integrationWhatsappService.findByIdForWorkspace(
        {
          id: integrationId,
          workspaceId,
        },
      )
      if (!integration) {
        throw new ChatbotXException(t("whatsappNotFound"))
      }

      await metaConversionsService.disconnectCapi({
        channel: "whatsapp",
        integration,
      })

      return { success: true }
    },
  )
