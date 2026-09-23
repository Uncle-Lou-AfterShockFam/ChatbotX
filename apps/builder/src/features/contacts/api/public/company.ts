import { companyService, contactService } from "@chatbotx.io/business"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import {
  possibleErrorsOnFindingResource,
  possibleErrorsOnMutatingResource,
} from "@/lib/orpc/orpc-error-helper"
import { workspaceTokenAuthAPIForScope } from "@/orpc"

const workspaceTokenAuthAPI = workspaceTokenAuthAPIForScope("contacts")

const identifier = z
  .string()
  .min(1)
  .describe(
    "Contact identifier: the numeric contact id, an email address, or a phone number.",
  )

export const contactsCompanyPublicRouter = {
  setCompany: workspaceTokenAuthAPI
    .route({
      method: "PUT",
      path: "/v1/contacts/{identifier}/company",
      summary: "Set contact company",
      description:
        "Links the contact to a company (see `companies.list`). Replaces any previous link.",
      successStatus: 204,
      tags: ["Contacts"],
    })
    .input(
      z.object({
        identifier,
        companyId: zodBigintAsString().describe(
          "Company id. Get it from `companies.list`.",
        ),
      }),
    )
    .errors(possibleErrorsOnMutatingResource)
    .handler(async ({ context, input }) => {
      const contactId = await contactService.resolveIdByIdentifier({
        identifier: input.identifier,
        workspaceId: context.workspace.id,
      })
      await companyService.assignContact({
        workspaceId: context.workspace.id,
        contactId,
        companyId: input.companyId,
      })
    }),

  clearCompany: workspaceTokenAuthAPI
    .route({
      method: "DELETE",
      path: "/v1/contacts/{identifier}/company",
      summary: "Clear contact company",
      description: "Unlinks the contact from its company.",
      successStatus: 204,
      tags: ["Contacts"],
    })
    .input(z.object({ identifier }))
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      const contactId = await contactService.resolveIdByIdentifier({
        identifier: input.identifier,
        workspaceId: context.workspace.id,
      })
      await companyService.assignContact({
        workspaceId: context.workspace.id,
        contactId,
        companyId: null,
      })
    }),
}
