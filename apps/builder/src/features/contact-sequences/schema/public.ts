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
          "active, completed, held (a step's required contact fields are missing; see lastError, then contacts.resumeSequence), or ended (see endReason; contacts.reactivateSequence resumes it).",
        ),
      lastError: z
        .string()
        .nullable()
        .describe("Why the subscription is held, e.g. `missing: first_name`."),
      enrolledAt: z.iso.datetime().describe("When the contact was enrolled."),
      completedAt: z.iso
        .datetime()
        .nullable()
        .describe("When the contact finished the last step."),
      endedAt: z.iso
        .datetime()
        .nullable()
        .describe("When the subscription ended (status ended)."),
      endReason: z
        .string()
        .nullable()
        .describe(
          "Why it ended: subscription_removed, unsubscribed_via_flow, company_stopped, contact_replied, no_email_thread, bounced or unsubscribed. bounced and unsubscribed are final.",
        ),
      replyState: z
        .string()
        .describe(
          "The contact's answer to this sequence: none, replied, ooo (out of office) or bounced. Separate from any pipeline stage.",
        ),
      repliedAt: z.iso
        .datetime()
        .nullable()
        .describe("When the contact replied."),
      pausedUntil: z.iso
        .datetime()
        .nullable()
        .describe("An out-of-office answer holds the next step until then."),
      currentStep: z
        .number()
        .int()
        .describe("The order of the next step to run (0 = the first)."),
      updatedAt: z.iso
        .datetime()
        .describe(
          "Last change; pass it as expectedUpdatedAt to contacts.reactivateSequence.",
        ),
    }),
  ),
})

export const reactivateContactSequencePublicRequest = z.object({
  expectedUpdatedAt: z.iso
    .datetime({ offset: true })
    .describe(
      "The subscription's updatedAt as contacts.listSequences returned it; a subscription changed since is refused (409 enrollmentChanged).",
    ),
})

export const reactivateContactSequencePublicResponse = z.object({
  runAt: z.iso
    .datetime()
    .nullable()
    .describe(
      "When the resumed step is scheduled (ISO 8601); null when the sequence has no active step.",
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
