import { z } from "zod"

/**
 * s228b outreach step 2: what a contact's answer to outreach was. The manual
 * classes an operator sets (they open or move the outreach deal); the rule
 * classes the line reports (recorded, never a deal).
 */
export const replyClassManualClasses = z.enum([
  "interested",
  "maybeLater",
  "notInterested",
])
export const replyClassRuleClasses = z.enum(["ooo", "auto", "bounce"])
export const replyClasses = z.enum([
  ...replyClassManualClasses.options,
  ...replyClassRuleClasses.options,
])
export type ReplyClass = z.infer<typeof replyClasses>
export type ReplyClassManual = z.infer<typeof replyClassManualClasses>

/** Who decided: the line's rules, an operator, or (later) an AI classifier. */
export const replyClassificationSources = z.enum(["rule", "manual", "ai"])
export type ReplyClassificationSource = z.infer<
  typeof replyClassificationSources
>

/** The Outreach pipeline's stages, in order; the class keys map onto them. */
export const OUTREACH_STAGE_KEYS = [
  "interested",
  "maybeLater",
  "meetingBooked",
  "meetingCompleted",
  "won",
  "notInterested",
] as const
export type OutreachStageKey = (typeof OUTREACH_STAGE_KEYS)[number]

const STAGE_ID = /^\d{1,19}$/

/** A sequence's outreach stage map: stage key -> PipelineStage id. */
export const outreachStagesSchema = z
  .object(
    Object.fromEntries(
      OUTREACH_STAGE_KEYS.map((key) => [key, z.string().regex(STAGE_ID)]),
    ) as Record<OutreachStageKey, z.ZodString>,
  )
  .strict()
export type OutreachStages = z.infer<typeof outreachStagesSchema>
