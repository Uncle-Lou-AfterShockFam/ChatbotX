import { crmTimelineService } from "@chatbotx.io/business"
import { documentService } from "@chatbotx.io/business/documents"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import {
  possibleErrorsOnFindingResource,
  possibleErrorsOnListingResource,
  possibleErrorsOnMutatingResource,
} from "@/lib/orpc/orpc-error-helper"
import { workspaceTokenAuthAPIForScope } from "@/orpc"
import { contactDocumentVariables } from "../lib/resolve-variables"
import { toContactDocumentResources } from "../lib/resource"
import {
  contactDocumentResource,
  documentTemplateResource,
  generateContactDocumentRequest,
} from "../schema/resource"

/** Documents over the workspace token (scope `contacts`: a document is contact data). */
const workspaceTokenAuthAPI = workspaceTokenAuthAPIForScope("contacts")
const contactIdInput = z.object({
  id: zodBigintAsString().describe("The contact's id."),
})
const generateInput = contactIdInput.and(
  z.object({
    templateId: generateContactDocumentRequest.shape.templateId.describe(
      "The document template to render (see `documents.listTemplates`).",
    ),
    ref: generateContactDocumentRequest.shape.ref.describe(
      "Optional idempotency key per contact (1-100 of A-Z a-z 0-9 . _ : -). The same ref returns the stored document instead of rendering again.",
    ),
  }),
)

export const documentsPublicRouter = {
  listTemplates: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/document-templates",
      summary: "List document templates",
      description:
        "Returns the active document templates of this workspace (HTML with `{{variable}}` merge fields), newest first.",
      tags: ["Documents"],
    })
    .output(z.object({ data: z.array(documentTemplateResource) }))
    .errors(possibleErrorsOnListingResource)
    .handler(async ({ context }) => ({
      data: await documentService.listTemplates({
        workspaceId: context.workspace.id,
      }),
    })),

  listForContact: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/contacts/{id}/documents",
      summary: "List contact documents",
      description:
        "Returns the documents generated for a contact, newest first, each with its public `downloadUrl` (valid until `linkExpiresAt`).",
      tags: ["Documents"],
    })
    .input(contactIdInput)
    .output(z.object({ data: z.array(contactDocumentResource) }))
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      const workspaceId = context.workspace.id
      await crmTimelineService.assertContact({
        workspaceId,
        contactId: input.id,
      })
      const rows = await documentService.listForContact({
        workspaceId,
        contactId: input.id,
      })
      return { data: await toContactDocumentResources(workspaceId, rows) }
    }),

  generateForContact: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/contacts/{id}/documents",
      summary: "Generate contact document",
      description:
        "Renders a template for the contact to a PDF and stores it on the contact. Idempotent per `ref`: the same `ref` returns the stored document (`created: false`).",
      tags: ["Documents"],
    })
    .input(generateInput)
    .output(
      z.object({ document: contactDocumentResource, created: z.boolean() }),
    )
    .errors(possibleErrorsOnMutatingResource)
    .handler(async ({ context, input }) => {
      const workspaceId = context.workspace.id
      const { document, created } = await documentService.generateForContact({
        workspaceId,
        contactId: input.id,
        templateId: input.templateId,
        ref: input.ref,
        resolveVariables: contactDocumentVariables(input.id),
      })
      const [resource] = await toContactDocumentResources(workspaceId, [
        document,
      ])
      return { document: resource, created }
    }),
}
