import {
  createSelectSchema,
  integrationTelegramModel,
} from "@chatbotx.io/database/schema"
import { zodBigintAsString } from "@chatbotx.io/utils"
import type { z } from "zod"

// No `auth` (s231a): it holds the bot token and the webhook secret.
export const integrationTelegramResource = createSelectSchema(
  integrationTelegramModel,
  {
    id: zodBigintAsString(),
    inboxId: zodBigintAsString(),
    workspaceId: zodBigintAsString(),
  },
).omit({ auth: true })

export type IntegrationTelegramResource = z.infer<
  typeof integrationTelegramResource
>
