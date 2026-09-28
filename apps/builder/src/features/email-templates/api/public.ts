import { emailTemplateService } from "@chatbotx.io/business/email-templates"
import { emailTemplateStatuses } from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import {
  possibleErrorsOnCreatingResource,
  possibleErrorsOnFindingResource,
  possibleErrorsOnListingResource,
  possibleErrorsOnMutatingResource,
} from "@/lib/orpc/orpc-error-helper"
import { workspaceTokenAuthAPIForScope } from "@/orpc"
import { emailTemplateData, emailTemplateResource } from "../schema/resource"

/** Email templates over the workspace token (scope `automation`, like flows). */
const workspaceTokenAuthAPI = workspaceTokenAuthAPIForScope("automation")
const tags = ["Email templates"]
const idInput = z.object({
  id: zodBigintAsString().describe("The email template's id."),
})

export const emailTemplatesPublicRouter = {
  list: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/email-templates",
      summary: "List email templates",
      description:
        "Returns this workspace's email templates (EmailDocument v1), newest first. Archived ones only with includeArchived.",
      tags,
    })
    .input(
      z.object({
        includeArchived: z.coerce
          .boolean()
          .optional()
          .describe("Also return archived templates."),
      }),
    )
    .output(z.object({ data: z.array(emailTemplateResource) }))
    .errors(possibleErrorsOnListingResource)
    .handler(async ({ input, context }) => ({
      data: await emailTemplateService.list({
        workspaceId: context.workspace.id,
        includeArchived: input.includeArchived,
      }),
    })),

  get: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/email-templates/{id}",
      summary: "Get email template",
      description:
        "Returns one email template with its EmailDocument. Use `emailTemplates.list` to find the id.",
      tags,
    })
    .input(idInput)
    .output(emailTemplateResource)
    .errors(possibleErrorsOnFindingResource)
    .handler(
      async ({ input, context }) =>
        await emailTemplateService.get({
          workspaceId: context.workspace.id,
          id: input.id,
        }),
    ),

  create: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/email-templates",
      summary: "Create email template",
      description:
        "Stores an EmailDocument v1 under a unique name. The document is validated strictly (unknown keys, bad links or oversized payloads are a 422).",
      tags,
    })
    .input(emailTemplateData)
    .output(emailTemplateResource)
    .errors(possibleErrorsOnCreatingResource)
    .handler(
      async ({ input, context }) =>
        await emailTemplateService.create({
          workspaceId: context.workspace.id,
          data: { name: input.name, document: input.document },
        }),
    ),

  update: workspaceTokenAuthAPI
    .route({
      method: "PUT",
      path: "/v1/email-templates/{id}",
      summary: "Replace email template",
      description:
        "Replaces the template's name and whole EmailDocument (validated like create). Flows that use it render the new version from their next send.",
      tags,
    })
    .input(idInput.and(emailTemplateData))
    .output(emailTemplateResource)
    .errors(possibleErrorsOnMutatingResource)
    .handler(
      async ({ input, context }) =>
        await emailTemplateService.update({
          workspaceId: context.workspace.id,
          id: input.id,
          data: { name: input.name, document: input.document },
        }),
    ),

  setStatus: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/email-templates/{id}/status",
      summary: "Archive or restore email template",
      description:
        "An archived template is hidden from the default list and the email step picker; restoring makes it active again.",
      tags,
    })
    .input(
      idInput.and(
        z.object({
          status: emailTemplateStatuses.describe(
            "`archived` to hide the template, `active` to restore it.",
          ),
        }),
      ),
    )
    .output(emailTemplateResource)
    .errors(possibleErrorsOnMutatingResource)
    .handler(
      async ({ input, context }) =>
        await emailTemplateService.setStatus({
          workspaceId: context.workspace.id,
          id: input.id,
          status: input.status,
        }),
    ),

  delete: workspaceTokenAuthAPI
    .route({
      method: "DELETE",
      path: "/v1/email-templates/{id}",
      summary: "Delete email template",
      description:
        "Permanently deletes the template. A flow step that still names it will fail that send.",
      successStatus: 204,
      tags,
    })
    .input(idInput)
    .errors(possibleErrorsOnMutatingResource)
    .handler(async ({ input, context }) => {
      await emailTemplateService.delete({
        workspaceId: context.workspace.id,
        id: input.id,
      })
    }),
}
