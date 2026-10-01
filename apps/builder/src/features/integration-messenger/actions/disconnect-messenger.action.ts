"use server"

import { zodBigintAsString } from "@chatbotx.io/utils"
import { settingsActionClientAllowExpired } from "@/lib/safe-action"
import { disconnectMessenger } from "./disconnect-messenger"

export const disconnectMessengerAction = settingsActionClientAllowExpired
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .action(async (props) => {
    const {
      bindArgsParsedInputs: [workspaceId, id],
    } = props

    await disconnectMessenger({ workspaceId, id })
  })
