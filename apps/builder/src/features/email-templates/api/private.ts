import { emailTemplateService } from "@chatbotx.io/business/email-templates"
import { emailTemplateStatuses } from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { ORPCError } from "@orpc/server"
import z from "zod"
import { withWorkspaceIdSchema } from "@/features/workspaces/schema/resource"
import { checkEmailPreviewRateLimit } from "@/lib/rate-limit/email-preview-rate-limit"
import { workspaceAuthorizedMidddleware } from "@/middlewares/auth"
import { authorizedAPI } from "@/orpc"
import {
  emailTemplateData,
  emailTemplatePreviewInput,
  emailTemplatePreviewResource,
  emailTemplateResource,
  includeArchivedParam,
} from "../schema/resource"

/** Email templates (roadmap B2): workspace-wide, like flows. */
const tags = ["Email templates"]
const withTemplateId = withWorkspaceIdSchema.and(
  z.object({ id: zodBigintAsString() }),
)

const privateListEmailTemplatesAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/email-templates",
    summary: "List email templates",
    tags,
  })
  .input(
    withWorkspaceIdSchema.and(
      z.object({ includeArchived: includeArchivedParam }),
    ),
  )
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .output(z.object({ data: z.array(emailTemplateResource) }))
  .handler(async ({ input }) => ({
    data: await emailTemplateService.list({
      workspaceId: input.workspaceId,
      includeArchived: input.includeArchived,
    }),
  }))

const privateGetEmailTemplateAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/email-templates/{id}",
    summary: "Get an email template",
    tags,
  })
  .input(withTemplateId)
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .output(emailTemplateResource)
  .handler(async ({ input }) => await emailTemplateService.get(input))

const privateCreateEmailTemplateAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/email-templates",
    summary: "Create an email template",
    tags,
  })
  .input(withWorkspaceIdSchema.and(emailTemplateData))
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .output(emailTemplateResource)
  .handler(
    async ({ input, context }) =>
      await emailTemplateService.create({
        workspaceId: input.workspaceId,
        userId: context.user.id,
        data: { name: input.name, document: input.document },
      }),
  )

const privateUpdateEmailTemplateAPI = authorizedAPI
  .route({
    method: "PUT",
    path: "/workspaces/{workspaceId}/email-templates/{id}",
    summary: "Update an email template",
    tags,
  })
  .input(withTemplateId.and(emailTemplateData))
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .output(emailTemplateResource)
  .handler(
    async ({ input }) =>
      await emailTemplateService.update({
        workspaceId: input.workspaceId,
        id: input.id,
        data: { name: input.name, document: input.document },
      }),
  )

const privateSetEmailTemplateStatusAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/email-templates/{id}/status",
    summary: "Archive or restore an email template",
    tags,
  })
  .input(withTemplateId.and(z.object({ status: emailTemplateStatuses })))
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .output(emailTemplateResource)
  .handler(async ({ input }) => await emailTemplateService.setStatus(input))

const privateDeleteEmailTemplateAPI = authorizedAPI
  .route({
    method: "DELETE",
    path: "/workspaces/{workspaceId}/email-templates/{id}",
    summary: "Delete an email template",
    tags,
  })
  .input(withTemplateId)
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .output(z.object({ ok: z.literal(true) }))
  .handler(async ({ input }) => {
    await emailTemplateService.delete(input)
    return { ok: true as const }
  })

const privatePreviewEmailTemplateAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/email-templates/preview",
    summary: "Preview an email document",
    description:
      "Renders a draft document as a send would (sample merge values, no tracking). A schema miss returns ok false with each issue's path instead of an error.",
    tags,
  })
  .input(withWorkspaceIdSchema.and(emailTemplatePreviewInput))
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .output(emailTemplatePreviewResource)
  .handler(async ({ input, context }) => {
    const { limited, retryAfter } = await checkEmailPreviewRateLimit({
      userId: String(context.user.id),
    })
    if (limited) {
      throw new ORPCError("TOO_MANY_REQUESTS", {
        status: 429,
        message: `Too many previews, retry in ${retryAfter}s`,
      })
    }
    return await emailTemplateService.preview({
      workspaceId: input.workspaceId,
      document: input.document,
      vars: input.vars,
    })
  })

export const privateEmailTemplatesAPI = {
  privatePreviewEmailTemplateAPI,
  privateListEmailTemplatesAPI,
  privateGetEmailTemplateAPI,
  privateCreateEmailTemplateAPI,
  privateUpdateEmailTemplateAPI,
  privateSetEmailTemplateStatusAPI,
  privateDeleteEmailTemplateAPI,
}
