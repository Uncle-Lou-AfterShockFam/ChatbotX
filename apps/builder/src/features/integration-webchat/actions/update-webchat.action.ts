"use server"

import { integrationWebchatService } from "@chatbotx.io/business"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { getTenantSettings } from "@/features/tenant/utils"
import { settingsActionClient } from "@/lib/safe-action"
import { applyWebchatBranding } from "../lib"
import { updateWebchatRequest } from "../schema/mutation"

export const updateWebchatAction = settingsActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .inputSchema(updateWebchatRequest)
  .action(async (props) => {
    const {
      bindArgsParsedInputs: [workspaceId, id],
      parsedInput,
    } = props
    const { authorizedDomains, ...rest } = parsedInput

    const integration = await integrationWebchatService.findByIdForWorkspace({
      id,
      workspaceId,
    })

    const persistentMenus = rest.persistentMenus
      ? applyWebchatBranding(
          rest.persistentMenus,
          (await getTenantSettings()).appUrl,
        )
      : rest.persistentMenus

    await integrationWebchatService.update({
      workspaceId,
      id: integration.id,
      data: {
        ...rest,
        persistentMenus,
        // Normalization (falsy -> null) and workspace-ownership validation
        // now live in `integrationWebchatService.update` so this action and
        // the public API handler cannot drift on this field.
        authorizedDomains: authorizedDomains
          ? authorizedDomains.map((domain) => domain.value)
          : undefined,
      },
    })
  })
