import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"

export const listContactSequencesPublicResponse = z.object({
  data: z.array(
    z.object({
      sequenceId: z.string(),
      sequenceName: z.string(),
      status: z
        .string()
        .nullable()
        .describe(
          "active, completed, or held (a step's required contact fields are missing; see lastError, then contacts.resumeSequence).",
        ),
      lastError: z
        .string()
        .nullable()
        .describe("Why the subscription is held, e.g. `missing: first_name`."),
    }),
  ),
})

export const contactSequenceIdsPublicRequest = z.object({
  sequenceIds: z
    .array(zodBigintAsString())
    .min(1, "At least one sequence id is required")
    .max(100)
    .describe(
      "Sequence ids (numeric strings), up to 100. Get them from `sequences.list`.",
    ),
})
export type ContactSequenceIdsPublicRequest = z.infer<
  typeof contactSequenceIdsPublicRequest
>

export const setContactSequencesPublicRequest = z.object({
  sequenceIds: z
    .array(zodBigintAsString())
    .max(100)
    .describe(
      "Sequence ids (numeric strings) the contact should be subscribed to, up to 100. Get them from `sequences.list`.",
    ),
})
export type SetContactSequencesPublicRequest = z.infer<
  typeof setContactSequencesPublicRequest
>

export const resumeContactSequencePublicResponse = z.object({
  runAt: z.string().describe("When the held step is now scheduled (ISO 8601)."),
})
