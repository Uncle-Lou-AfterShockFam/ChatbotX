"use server"

import { flowService } from "@chatbotx.io/business"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { flowsActionClient } from "@/lib/safe-action"

export const duplicateFlowAction = flowsActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .action(({ bindArgsParsedInputs: [workspaceId, id] }) =>
    flowService.duplicate({ workspaceId, id }),
  )
