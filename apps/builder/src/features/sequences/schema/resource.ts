import { outreachStagesSchema } from "@chatbotx.io/database/partials"
import { createSelectSchema, sequenceModel } from "@chatbotx.io/database/schema"
import z from "zod"

export const sequenceResource = createSelectSchema(sequenceModel, {
  id: z.string(),
  workspaceId: z.string(),
  folderId: z.string().nullable(),
  // s228b outreach step 2: the linked Outreach pipeline and its stage map.
  outreachPipelineId: z.string().nullable(),
  outreachStages: outreachStagesSchema.nullable(),
})
export type SequenceResource = typeof sequenceModel.$inferSelect
