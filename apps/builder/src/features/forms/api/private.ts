import { formService } from "@chatbotx.io/business/form"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"
import { withWorkspaceIdSchema } from "@/features/workspaces/schema/resource"
import { contactsAccessAuthorizedMiddleware } from "@/middlewares/auth"
import { authorizedAPI } from "@/orpc"
import {
  createFormRequest,
  formResource,
  formSubmissionResource,
  formSummaryResource,
  listFormSubmissionsQuery,
  setFormStatusRequest,
  updateFormRequest,
} from "../schema/resource"

/**
 * Forms (s200): workspace-wide, behind the contacts-section gate like
 * documents. Every route scopes on `workspaceId`; the service 404s a form
 * of another workspace. The public page and submit route live under
 * `/forms/...` and `/api/forms/...` (PR2), not here.
 */
const tags = ["Forms"]
const withFormId = withWorkspaceIdSchema.and(
  z.object({ id: zodBigintAsString() }),
)
const withSubmissionId = withWorkspaceIdSchema.and(
  z.object({ id: zodBigintAsString(), submissionId: zodBigintAsString() }),
)

const privateListFormsAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/forms",
    summary: "List forms",
    tags,
  })
  .input(
    withWorkspaceIdSchema.and(
      z.object({ includeArchived: z.coerce.boolean().optional() }),
    ),
  )
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ data: z.array(formSummaryResource) }))
  .handler(async ({ input }) => ({
    data: await formService.list({
      workspaceId: input.workspaceId,
      includeArchived: input.includeArchived,
    }),
  }))

const privateGetFormAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/forms/{id}",
    summary: "Get a form",
    tags,
  })
  .input(withFormId)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(formResource)
  .handler(async ({ input }) => await formService.get(input))

const privateCreateFormAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/forms",
    summary: "Create a form",
    tags,
  })
  .input(withWorkspaceIdSchema.and(createFormRequest))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(formResource)
  .handler(
    async ({ input, context }) =>
      await formService.create({
        workspaceId: input.workspaceId,
        userId: context.user.id,
        data: { title: input.title, slug: input.slug },
      }),
  )

const privateUpdateFormAPI = authorizedAPI
  .route({
    method: "PUT",
    path: "/workspaces/{workspaceId}/forms/{id}",
    summary: "Update a form (draft definition, settings, title, slug, inbox)",
    tags,
  })
  .input(withFormId.and(updateFormRequest))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(formResource)
  .handler(
    async ({ input }) =>
      await formService.update({
        workspaceId: input.workspaceId,
        id: input.id,
        force: input.force,
        data: {
          title: input.title,
          slug: input.slug,
          definition: input.definition,
          settings: input.settings,
          inboxId: input.inboxId,
        },
      }),
  )

const privatePublishFormAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/forms/{id}/publish",
    summary: "Publish the draft definition",
    tags,
  })
  .input(withFormId)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(formResource)
  .handler(async ({ input }) => await formService.publish(input))

const privateSetFormStatusAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/forms/{id}/status",
    summary: "Unpublish (draft) or archive a form",
    tags,
  })
  .input(withFormId.and(setFormStatusRequest))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(formResource)
  .handler(async ({ input }) => await formService.setStatus(input))

const privateDuplicateFormAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/forms/{id}/duplicate",
    summary: "Duplicate a form as a new draft",
    tags,
  })
  .input(withFormId)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(formResource)
  .handler(
    async ({ input, context }) =>
      await formService.duplicate({
        workspaceId: input.workspaceId,
        id: input.id,
        userId: context.user.id,
      }),
  )

const privateDeleteFormAPI = authorizedAPI
  .route({
    method: "DELETE",
    path: "/workspaces/{workspaceId}/forms/{id}",
    summary: "Delete a form and its submissions",
    tags,
  })
  .input(withFormId)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ ok: z.literal(true) }))
  .handler(async ({ input }) => {
    await formService.delete(input)
    return { ok: true as const }
  })

const privateListFormSubmissionsAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/forms/{id}/submissions",
    summary: "List a form's submissions (newest first, keyset)",
    tags,
  })
  .input(withFormId.and(listFormSubmissionsQuery))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(
    z.object({
      data: z.array(formSubmissionResource),
      nextCursor: z.string().nullable(),
    }),
  )
  .handler(
    async ({ input }) =>
      await formService.listSubmissions({
        workspaceId: input.workspaceId,
        formId: input.id,
        cursor: input.cursor,
        limit: input.limit,
      }),
  )

const privateDeleteFormSubmissionAPI = authorizedAPI
  .route({
    method: "DELETE",
    path: "/workspaces/{workspaceId}/forms/{id}/submissions/{submissionId}",
    summary: "Delete a submission",
    tags,
  })
  .input(withSubmissionId)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ ok: z.literal(true) }))
  .handler(async ({ input }) => {
    await formService.deleteSubmission({
      workspaceId: input.workspaceId,
      formId: input.id,
      id: input.submissionId,
    })
    return { ok: true as const }
  })

export const privateFormsAPI = {
  privateListFormsAPI,
  privateGetFormAPI,
  privateCreateFormAPI,
  privateUpdateFormAPI,
  privatePublishFormAPI,
  privateSetFormStatusAPI,
  privateDuplicateFormAPI,
  privateDeleteFormAPI,
  privateListFormSubmissionsAPI,
  privateDeleteFormSubmissionAPI,
}
