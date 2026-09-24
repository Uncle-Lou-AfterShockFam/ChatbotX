import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"

export const companyNoteRelations = defineRelationsPart(schema, (r) => ({
  companyNoteModel: {
    company: r.one.companyModel({
      from: r.companyNoteModel.companyId,
      to: r.companyModel.id,
      optional: false,
    }),
    createdBy: r.one.userModel({
      from: r.companyNoteModel.createdById,
      to: r.userModel.id,
    }),
  },
}))
