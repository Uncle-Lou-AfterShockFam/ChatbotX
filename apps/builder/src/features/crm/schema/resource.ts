import {
  companyActivityTypes,
  questionnaireSubmissionStatuses,
} from "@chatbotx.io/database/partials"
import {
  companyActivityModel,
  companyNoteModel,
  createSelectSchema,
} from "@chatbotx.io/database/schema"
import z from "zod"

export const companyNoteResource = createSelectSchema(companyNoteModel, {
  id: z.string(),
  workspaceId: z.string(),
  companyId: z.string(),
  createdById: z.string().nullable(),
})
export type CompanyNoteResource = z.infer<typeof companyNoteResource>

export const companyActivityResource = createSelectSchema(
  companyActivityModel,
  {
    id: z.string(),
    workspaceId: z.string(),
    companyId: z.string(),
    actorId: z.string().nullable(),
    type: companyActivityTypes,
    payload: z.record(z.string(), z.unknown()),
  },
)
export type CompanyActivityResource = z.infer<typeof companyActivityResource>

export const timelineKindSchema = z.enum([
  "companyActivity",
  "companyNote",
  "contactNote",
  "dealActivity",
  "submission",
  "appointment",
])
export type TimelineKind = z.infer<typeof timelineKindSchema>

export const timelineRowResource = z.object({
  kind: timelineKindSchema,
  id: z.string(),
  at: z.coerce.date(),
  payload: z.record(z.string(), z.unknown()),
})
export type TimelineRowResource = z.infer<typeof timelineRowResource>

export const timelinePageResource = z.object({
  data: z.array(timelineRowResource),
  nextCursor: z.string().nullable(),
})
export type TimelinePageResource = z.infer<typeof timelinePageResource>

export const submissionSummaryResource = z.object({
  id: z.string(),
  questionnaireId: z.string(),
  questionnaireName: z.string(),
  contactId: z.string(),
  status: questionnaireSubmissionStatuses,
  totalPoints: z.number().int().nullable(),
  completedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
})
export type SubmissionSummaryResource = z.infer<
  typeof submissionSummaryResource
>

/** A contact's DM conversation as the 360 pages list it (one per contact). */
export const conversationSummaryResource = z.object({
  id: z.string(),
  contactId: z.string(),
  contactName: z.string().nullable(),
  lastActivityAt: z.coerce.date().nullable(),
  archivedAt: z.coerce.date().nullable(),
  contactRepliedAt: z.coerce.date().nullable(),
  adminRepliedAt: z.coerce.date().nullable(),
})
export type ConversationSummaryResource = z.infer<
  typeof conversationSummaryResource
>

export const companyMetricsResource = z.object({
  contacts: z.number().int(),
  openDeals: z.number().int(),
  openValue: z.string(),
  wonValue: z.string(),
  openTasks: z.number().int(),
  overdueTasks: z.number().int(),
  lastActivityAt: z.coerce.date().nullable(),
})
export type CompanyMetricsResource = z.infer<typeof companyMetricsResource>
