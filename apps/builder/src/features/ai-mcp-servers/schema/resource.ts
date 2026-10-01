import { aiMcpServerAuthTypes } from "@chatbotx.io/database/partials"
import {
  aiMCPServerModel,
  createSelectSchema,
} from "@chatbotx.io/database/schema"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"

// `auth` as a builder client may see it (s232a). The stored row holds a raw
// bearer token or raw custom header values; the client gets the header names
// with empty values and the token only when it is a `{{bot_field:<id>}}`
// reference (the secret is the bot field's value, never shown here). An empty
// value sent back on update or validate means "keep the stored one".
export const aiMcpServerClientAuth = z.discriminatedUnion("type", [
  z.object({ type: z.literal(aiMcpServerAuthTypes.enum.none) }),
  z.object({
    type: z.literal(aiMcpServerAuthTypes.enum.token),
    token: z.string(),
  }),
  z.object({
    type: z.literal(aiMcpServerAuthTypes.enum.header),
    headers: z.array(z.object({ header: z.string(), value: z.string() })),
  }),
])
export type AIMcpServerClientAuth = z.infer<typeof aiMcpServerClientAuth>

export const aiMcpServerResource = createSelectSchema(aiMCPServerModel, {
  id: zodBigintAsString(),
  workspaceId: zodBigintAsString(),
}).extend({
  auth: aiMcpServerClientAuth,
  availableTools: z.record(z.string(), z.any()),
})
export type AIMcpServerResource = z.infer<typeof aiMcpServerResource>
