import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"

export const companyRelations = defineRelationsPart(schema, (r) => ({
  companyModel: {
    workspace: r.one.workspaceModel({
      from: r.companyModel.workspaceId,
      to: r.workspaceModel.id,
    }),
    contacts: r.many.contactModel({
      from: r.companyModel.id,
      to: r.contactModel.companyId,
    }),
  },
}))
