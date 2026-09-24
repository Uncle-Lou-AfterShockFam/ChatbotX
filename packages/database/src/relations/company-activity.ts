import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"

export const companyActivityRelations = defineRelationsPart(schema, (r) => ({
  companyActivityModel: {
    company: r.one.companyModel({
      from: r.companyActivityModel.companyId,
      to: r.companyModel.id,
      optional: false,
    }),
    actor: r.one.userModel({
      from: r.companyActivityModel.actorId,
      to: r.userModel.id,
    }),
  },
}))
