import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"

export const formRelations = defineRelationsPart(schema, (r) => ({
  formModel: {
    workspace: r.one.workspaceModel({
      from: r.formModel.workspaceId,
      to: r.workspaceModel.id,
    }),
    inbox: r.one.inboxModel({
      from: r.formModel.inboxId,
      to: r.inboxModel.id,
    }),
    submissions: r.many.formSubmissionModel({
      from: r.formModel.id,
      to: r.formSubmissionModel.formId,
    }),
  },
  formSubmissionModel: {
    workspace: r.one.workspaceModel({
      from: r.formSubmissionModel.workspaceId,
      to: r.workspaceModel.id,
    }),
    form: r.one.formModel({
      from: r.formSubmissionModel.formId,
      to: r.formModel.id,
    }),
    contact: r.one.contactModel({
      from: r.formSubmissionModel.contactId,
      to: r.contactModel.id,
    }),
  },
}))
