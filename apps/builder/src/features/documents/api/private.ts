import { crmTimelineService } from "@chatbotx.io/business"
import { documentService } from "@chatbotx.io/business/documents"
import { documentTemplateStatuses } from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { contactDocumentVariables } from "@chatbotx.io/variables"
import z from "zod"
import { requireContactPermissionScope } from "@/features/contacts/permissions"
import { withWorkspaceIdSchema } from "@/features/workspaces/schema/resource"
import { contactsAccessAuthorizedMiddleware } from "@/middlewares/auth"
import { authorizedAPI } from "@/orpc"
import { toContactDocumentResources } from "../lib/resource"
import {
  contactDocumentResource,
  documentTemplateData,
  documentTemplateResource,
  generateContactDocumentRequest,
} from "../schema/resource"

/**
 * Documents (roadmap B3). Templates are workspace-wide; contact documents sit
 * behind the contacts-section gate AND the member's assigned-only scope
 * (crmTimelineService.assertContact 404s a contact outside it).
 */
const tags = ["Documents"]
const withTemplateId = withWorkspaceIdSchema.and(
  z.object({ id: zodBigintAsString() }),
)
const withContactId = withWorkspaceIdSchema.and(
  z.object({ contactId: zodBigintAsString() }),
)

const privateListDocumentTemplatesAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/document-templates",
    summary: "List document templates",
    tags,
  })
  .input(
    withWorkspaceIdSchema.and(
      z.object({ includeArchived: z.coerce.boolean().optional() }),
    ),
  )
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ data: z.array(documentTemplateResource) }))
  .handler(async ({ input }) => ({
    data: await documentService.listTemplates({
      workspaceId: input.workspaceId,
      includeArchived: input.includeArchived,
    }),
  }))

const privateGetDocumentTemplateAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/document-templates/{id}",
    summary: "Get a document template",
    tags,
  })
  .input(withTemplateId)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(documentTemplateResource)
  .handler(async ({ input }) => await documentService.getTemplate(input))

const privateCreateDocumentTemplateAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/document-templates",
    summary: "Create a document template",
    tags,
  })
  .input(withWorkspaceIdSchema.and(documentTemplateData))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(documentTemplateResource)
  .handler(
    async ({ input, context }) =>
      await documentService.createTemplate({
        workspaceId: input.workspaceId,
        userId: context.user.id,
        data: { name: input.name, bodyHtml: input.bodyHtml },
      }),
  )

const privateUpdateDocumentTemplateAPI = authorizedAPI
  .route({
    method: "PUT",
    path: "/workspaces/{workspaceId}/document-templates/{id}",
    summary: "Update a document template",
    tags,
  })
  .input(withTemplateId.and(documentTemplateData))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(documentTemplateResource)
  .handler(
    async ({ input }) =>
      await documentService.updateTemplate({
        workspaceId: input.workspaceId,
        id: input.id,
        data: { name: input.name, bodyHtml: input.bodyHtml },
      }),
  )

const privateSetDocumentTemplateStatusAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/document-templates/{id}/status",
    summary: "Archive or restore a document template",
    tags,
  })
  .input(withTemplateId.and(z.object({ status: documentTemplateStatuses })))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(documentTemplateResource)
  .handler(async ({ input }) => await documentService.setTemplateStatus(input))

const privateDeleteDocumentTemplateAPI = authorizedAPI
  .route({
    method: "DELETE",
    path: "/workspaces/{workspaceId}/document-templates/{id}",
    summary: "Delete a document template",
    tags,
  })
  .input(withTemplateId)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ ok: z.literal(true) }))
  .handler(async ({ input }) => {
    await documentService.deleteTemplate(input)
    return { ok: true as const }
  })

const privateListContactDocumentsAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/contacts/{contactId}/documents",
    summary: "List a contact's documents",
    tags,
  })
  .input(withContactId)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ data: z.array(contactDocumentResource) }))
  .handler(async ({ input }) => {
    await crmTimelineService.assertContact({
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      accessScope: await requireContactPermissionScope(input.workspaceId),
    })
    const rows = await documentService.listForContact(input)
    return { data: await toContactDocumentResources(input.workspaceId, rows) }
  })

const privateGenerateContactDocumentAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/contacts/{contactId}/documents",
    summary: "Generate a document for a contact",
    tags,
  })
  .input(withContactId.and(generateContactDocumentRequest))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ document: contactDocumentResource, created: z.boolean() }))
  .handler(async ({ input }) => {
    await crmTimelineService.assertContact({
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      accessScope: await requireContactPermissionScope(input.workspaceId),
    })
    const { document, created } = await documentService.generateForContact({
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      templateId: input.templateId,
      ref: input.ref,
      resolveVariables: contactDocumentVariables(input.contactId),
    })
    const [resource] = await toContactDocumentResources(input.workspaceId, [
      document,
    ])
    return { document: resource, created }
  })

export const privateDocumentsAPI = {
  privateListDocumentTemplatesAPI,
  privateGetDocumentTemplateAPI,
  privateCreateDocumentTemplateAPI,
  privateUpdateDocumentTemplateAPI,
  privateSetDocumentTemplateStatusAPI,
  privateDeleteDocumentTemplateAPI,
  privateListContactDocumentsAPI,
  privateGenerateContactDocumentAPI,
}
