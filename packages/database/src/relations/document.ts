import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"

export const documentRelations = defineRelationsPart(schema, (r) => ({
  documentTemplateModel: {
    workspace: r.one.workspaceModel({
      from: r.documentTemplateModel.workspaceId,
      to: r.workspaceModel.id,
    }),
    documents: r.many.contactDocumentModel({
      from: r.documentTemplateModel.id,
      to: r.contactDocumentModel.templateId,
    }),
  },
  contactDocumentModel: {
    workspace: r.one.workspaceModel({
      from: r.contactDocumentModel.workspaceId,
      to: r.workspaceModel.id,
    }),
    contact: r.one.contactModel({
      from: r.contactDocumentModel.contactId,
      to: r.contactModel.id,
    }),
    template: r.one.documentTemplateModel({
      from: r.contactDocumentModel.templateId,
      to: r.documentTemplateModel.id,
    }),
  },
}))
