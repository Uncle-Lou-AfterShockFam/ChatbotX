import { z } from "zod"
import { contactInboxResource } from "@/features/contact-inboxes/schema/resource"

export const listContactInboxesPublicResponse = z.object({
  data: z.array(contactInboxResource),
})

export const attachContactInboxPublicResponse = z.object({
  data: contactInboxResource,
  created: z.boolean(),
  ownedByAnotherContact: z.boolean(),
})
