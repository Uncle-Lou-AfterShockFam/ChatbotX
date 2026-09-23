import { companyService } from "@chatbotx.io/business"
import { stopCompany } from "@chatbotx.io/business/company-stop"
import { notFoundException } from "@chatbotx.io/business/errors"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import {
  possibleErrorsOnCreatingEmailTopic,
  possibleErrorsOnDeletingResource,
  possibleErrorsOnFindingResource,
  possibleErrorsOnListingResource,
  possibleErrorsOnMutatingEmailTopic,
} from "@/lib/orpc/orpc-error-helper"
import { workspaceTokenAuthAPIForScope } from "@/orpc"
import { stopCompanyRequest } from "../schema/action"
import {
  companyPublicResource,
  createCompanyPublicRequest,
  listCompaniesPublicRequest,
  listCompaniesPublicResponse,
  updateCompanyPublicRequest,
} from "../schema/public"
import { companyStopResultSchema } from "../schema/resource"

const workspaceTokenAuthAPI = workspaceTokenAuthAPIForScope("contacts")

const idInput = z.object({
  id: zodBigintAsString().describe("Company id. Get it from `companies.list`."),
})

export const companiesPublicRouter = {
  list: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/companies",
      summary: "List companies",
      description:
        "Companies group contacts for the company stop rule. Returns companies in this workspace with their contact count.",
      tags: ["Companies"],
    })
    .input(listCompaniesPublicRequest)
    .output(listCompaniesPublicResponse)
    .errors(possibleErrorsOnListingResource)
    .handler(
      async ({ context, input }) =>
        await companyService.list({
          ...input,
          workspaceId: context.workspace.id,
        }),
    ),

  get: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/companies/{id}",
      summary: "Get company",
      description: "Returns one company. Use `companies.list` to find its id.",
      tags: ["Companies"],
    })
    .input(idInput)
    .output(companyPublicResource)
    .errors(possibleErrorsOnFindingResource)
    .handler(
      async ({ context, input }) =>
        await companyService.findOrFail({
          workspaceId: context.workspace.id,
          id: input.id,
        }),
    ),

  create: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/companies",
      summary: "Create company",
      description:
        "Adds a company. Give it the email domains it owns so inbound email from those domains links contacts automatically.",
      successStatus: 201,
      tags: ["Companies"],
    })
    .input(createCompanyPublicRequest)
    .output(z.object({ id: zodBigintAsString() }))
    .errors(possibleErrorsOnCreatingEmailTopic)
    .handler(async ({ context, input }) => {
      const company = await companyService.create({
        workspaceId: context.workspace.id,
        data: input,
      })
      return { id: company.id }
    }),

  update: workspaceTokenAuthAPI
    .route({
      method: "PATCH",
      path: "/v1/companies/{id}",
      summary: "Update company",
      description:
        "Merges the given fields into a company: name, email domains, website, phone, notes or stopOnReply. Omitted fields are left unchanged.",
      tags: ["Companies"],
    })
    .input(updateCompanyPublicRequest)
    .output(companyPublicResource)
    .errors(possibleErrorsOnMutatingEmailTopic)
    .handler(async ({ context, input }) => {
      const { id, ...data } = input
      return await companyService.update({
        workspaceId: context.workspace.id,
        id,
        data,
      })
    }),

  delete: workspaceTokenAuthAPI
    .route({
      method: "DELETE",
      path: "/v1/companies/{id}",
      summary: "Delete company",
      description: "Deletes a company. Its contacts are kept and unlinked.",
      tags: ["Companies"],
      successStatus: 204,
    })
    .input(idInput)
    .errors(possibleErrorsOnDeletingResource)
    .handler(async ({ context, input }) => {
      const { deletedCount } = await companyService.delete({
        workspaceId: context.workspace.id,
        ids: [input.id],
      })
      if (deletedCount === 0) {
        throw notFoundException("Company not found")
      }
    }),

  stop: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/companies/{id}/stop",
      summary: "Stop company",
      description:
        "Stops every automation for every contact of the company: sequence enrolments are removed, parked flow waits are canceled, unsent broadcast rows are excluded and every contact is tagged `company-stopped`. Idempotent: a second call returns `already_stopped` unless `force` is true.",
      tags: ["Companies"],
    })
    .input(idInput.merge(stopCompanyRequest))
    .output(companyStopResultSchema)
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      await companyService.findOrFail({
        workspaceId: context.workspace.id,
        id: input.id,
      })
      return await stopCompany({
        workspaceId: context.workspace.id,
        companyId: input.id,
        reason: "api",
        force: input.force,
      })
    }),
}
