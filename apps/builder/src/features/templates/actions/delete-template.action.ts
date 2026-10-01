"use server"

import { templateService } from "@chatbotx.io/business"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { settingsActionClient } from "@/lib/safe-action"

export const deleteTemplateAction = settingsActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .action(async (props) => {
    const {
      bindArgsParsedInputs: [workspaceId, templateId],
    } = props
    await templateService.softDelete({ workspaceId, templateId })
  })
