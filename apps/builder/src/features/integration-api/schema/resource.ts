import {
  createSelectSchema,
  integrationApiModel,
} from "@chatbotx.io/database/schema"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"

export const apiResource = createSelectSchema(integrationApiModel, {
  id: zodBigintAsString(),
  inboxId: zodBigintAsString(),
  workspaceId: zodBigintAsString(),
})
  .pick({
    id: true,
    name: true,
    tokenPrefix: true,
    callbackUrl: true,
    enabled: true,
    createdAt: true,
  })
  .extend({
    /** From `auth.deliveryMode`; absent means push. */
    deliveryMode: z.enum(["push", "pull"]),
    /** From `auth.shortenLinks`; absent means on. */
    shortenLinks: z.boolean(),
  })
export type ApiResource = z.infer<typeof apiResource>
