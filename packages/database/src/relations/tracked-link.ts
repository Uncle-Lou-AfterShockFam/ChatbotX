import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"

export const trackedLinkRelations = defineRelationsPart(schema, (r) => ({
  trackedLinkModel: {
    workspace: r.one.workspaceModel({
      from: r.trackedLinkModel.workspaceId,
      to: r.workspaceModel.id,
    }),
    contact: r.one.contactModel({
      from: r.trackedLinkModel.contactId,
      to: r.contactModel.id,
    }),
    contactInbox: r.one.contactInboxModel({
      from: r.trackedLinkModel.contactInboxId,
      to: r.contactInboxModel.id,
    }),
  },
}))
