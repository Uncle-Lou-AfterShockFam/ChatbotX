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
    session: r.one.formSessionModel({
      from: r.formSubmissionModel.formSessionId,
      to: r.formSessionModel.id,
    }),
  },
  formSessionModel: {
    workspace: r.one.workspaceModel({
      from: r.formSessionModel.workspaceId,
      to: r.workspaceModel.id,
    }),
    form: r.one.formModel({
      from: r.formSessionModel.formId,
      to: r.formModel.id,
    }),
    contact: r.one.contactModel({
      from: r.formSessionModel.contactId,
      to: r.contactModel.id,
    }),
    conversation: r.one.conversationModel({
      from: r.formSessionModel.conversationId,
      to: r.conversationModel.id,
    }),
  },
  formVisitModel: {
    workspace: r.one.workspaceModel({
      from: r.formVisitModel.workspaceId,
      to: r.workspaceModel.id,
    }),
    form: r.one.formModel({
      from: r.formVisitModel.formId,
      to: r.formModel.id,
    }),
    contact: r.one.contactModel({
      from: r.formVisitModel.contactId,
      to: r.contactModel.id,
    }),
  },
}))
