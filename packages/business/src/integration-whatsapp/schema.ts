import {
  createSelectSchema,
  integrationWhatsappModel,
} from "@chatbotx.io/database/schema"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"

export const integrationWhatsappResource = createSelectSchema(
  integrationWhatsappModel,
  {
    id: zodBigintAsString(),
    inboxId: zodBigintAsString(),
  },
).pick({
  id: true,
  name: true,
  inboxId: true,
  displayPhoneNumber: true,
  tokenRefreshError: true,
  phoneNumberId: true,
  wabaId: true,
  hasCapiScope: true,
  capiScopeCheckedAt: true,
  datasetId: true,
})

export type IntegrationWhatsappResource = z.infer<
  typeof integrationWhatsappResource
>

export const listIntegrationWhatsappsResponse = z.array(
  integrationWhatsappResource,
)
export type ListIntegrationWhatsappResponse = z.infer<
  typeof listIntegrationWhatsappsResponse
>

/**
 * The WhatsApp fields a template or flow list carries: the lists reach the
 * browser (the templates / flows pages, conversion events, the APIs), so the
 * join is the `integrationWhatsappResource` allowlist, never `auth` or
 * `capiAccessToken` (s231a).
 */
export const WHATSAPP_LIST_INTEGRATION = {
  integrationWhatsapp: {
    columns: {
      id: true,
      name: true,
      inboxId: true,
      displayPhoneNumber: true,
      tokenRefreshError: true,
      phoneNumberId: true,
      wabaId: true,
      hasCapiScope: true,
      capiScopeCheckedAt: true,
      datasetId: true,
    },
  },
} as const
