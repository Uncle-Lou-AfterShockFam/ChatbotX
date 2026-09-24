import { companyService } from "@chatbotx.io/business"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"
import { withWorkspaceIdSchema } from "@/features/workspaces/schema/resource"
import { workspaceAuthorizedMidddleware } from "@/middlewares/auth"
import { authorizedAPI } from "@/orpc"
import {
  createCompanyRequest,
  setContactCompanyRequest,
  updateCompanyRequest,
} from "../schema/action"
import { listCompaniesRequest, listCompaniesResponse } from "../schema/query"
import { companyResource } from "../schema/resource"

const privateListWorkspaceCompaniesAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/companies",
    summary: "List companies",
    tags: ["Companies"],
  })
  .input(listCompaniesRequest.and(withWorkspaceIdSchema))
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .output(listCompaniesResponse)
  .handler(async ({ input }) => await companyService.list(input))

const privateGetCompanyAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/companies/{id}",
    summary: "Get company",
    tags: ["Companies"],
  })
  .input(withWorkspaceIdSchema.and(z.object({ id: zodBigintAsString() })))
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .output(companyResource)
  .handler(async ({ input }) => await companyService.findOrFail(input))

const privateCreateWorkspaceCompanyAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/companies",
    summary: "Create a company",
    tags: ["Companies"],
  })
  .input(createCompanyRequest.and(withWorkspaceIdSchema))
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .output(z.object({ id: zodBigintAsString() }))
  .handler(async ({ input, context }) => {
    const { workspaceId, ...data } = input
    const company = await companyService.create({
      workspaceId,
      data,
      actorId: context.user.id,
    })
    return { id: company.id }
  })

const privateUpdateCompanyAPI = authorizedAPI
  .route({
    method: "PUT",
    path: "/workspaces/{workspaceId}/companies/{id}",
    summary: "Update company",
    tags: ["Companies"],
  })
  .input(
    updateCompanyRequest
      .and(withWorkspaceIdSchema)
      .and(z.object({ id: zodBigintAsString() })),
  )
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .handler(async ({ input, context }) => {
    const { workspaceId, id, ...data } = input
    return await companyService.update({
      workspaceId,
      id,
      data,
      actorId: context.user.id,
    })
  })

const privateDeleteCompanyAPI = authorizedAPI
  .route({
    method: "DELETE",
    path: "/workspaces/{workspaceId}/companies/{id}",
    summary: "Delete company",
    tags: ["Companies"],
  })
  .input(withWorkspaceIdSchema.and(z.object({ id: zodBigintAsString() })))
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .handler(async ({ input }) => {
    await companyService.delete({
      workspaceId: input.workspaceId,
      ids: [input.id],
    })
  })

const privateSetContactCompanyAPI = authorizedAPI
  .route({
    method: "PUT",
    path: "/workspaces/{workspaceId}/contacts/{contactId}/company",
    summary: "Set a contact's company",
    tags: ["Companies"],
  })
  .input(setContactCompanyRequest.and(withWorkspaceIdSchema))
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .handler(async ({ input, context }) => {
    await companyService.assignContact({ ...input, actorId: context.user.id })
  })

export const privateCompaniesAPI = {
  privateListWorkspaceCompaniesAPI,
  privateGetCompanyAPI,
  privateCreateWorkspaceCompanyAPI,
  privateUpdateCompanyAPI,
  privateDeleteCompanyAPI,
  privateSetContactCompanyAPI,
}
