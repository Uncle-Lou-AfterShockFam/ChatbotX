import "server-only"

import { automatedResponseService } from "@chatbotx.io/business"
import type { AutomatedResponseType } from "@chatbotx.io/database/partials"
import z from "zod"

export const enableRequest = z.object({
  status: z.boolean(),
})
type EnableRequest = z.infer<typeof enableRequest>

export const enableAutomatedResponse = async (
  ctx: { workspaceId: string; id: string; type: AutomatedResponseType },
  parsedInput: EnableRequest,
) => {
  await automatedResponseService.findOrFail({
    workspaceId: ctx.workspaceId,
    id: ctx.id,
    type: ctx.type,
  })
  await automatedResponseService.setStatus(ctx, parsedInput.status)
}
