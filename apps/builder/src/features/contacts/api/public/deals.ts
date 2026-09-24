import { contactService } from "@chatbotx.io/business"
import { dealService } from "@chatbotx.io/business/deal"
import { z } from "zod"
import { dealPublicResource } from "@/features/deals/schema/public"
import { possibleErrorsOnFindingResource } from "@/lib/orpc/orpc-error-helper"
import { workspaceTokenAuthAPIForScope } from "@/orpc"

const workspaceTokenAuthAPI = workspaceTokenAuthAPIForScope("contacts")

const identifier = z
  .string()
  .min(1)
  .describe(
    "Contact identifier: the numeric contact id, an email address, or a phone number.",
  )

export const contactsDealsPublicRouter = {
  listDeals: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/contacts/{identifier}/deals",
      summary: "List contact deals",
      description:
        "Returns every deal of the contact, newest first, across all pipelines and statuses.",
      tags: ["Contacts"],
    })
    .input(z.object({ identifier }))
    .output(z.object({ data: z.array(dealPublicResource) }))
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      const contactId = await contactService.resolveIdByIdentifier({
        identifier: input.identifier,
        workspaceId: context.workspace.id,
      })
      return {
        data: await dealService.listByContactId({
          workspaceId: context.workspace.id,
          contactId,
        }),
      }
    }),
}
