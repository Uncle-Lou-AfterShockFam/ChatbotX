import { createId, zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { actionSteps } from "../shared"
import { uploadModes } from "../types"
import { buttonTypes } from "./button"
import { openWebsiteStepSchema } from "./open-website"
import { startAnotherNodeStepSchema } from "./start-another-node"
import { startExternalFlowStepSchema } from "./start-external-flow"
import { startExternalNodeStepSchema } from "./start-external-node"
import { stepTypes } from "./step-action"

export const pageElementTypes = z.enum([
  "heading",
  "text",
  "image",
  "button",
  "spacing",
  "code",
  "line",
])
export type PageElementType = z.infer<typeof pageElementTypes>

export const pageElementSchema = z.discriminatedUnion("type", [
  z.object({
    id: zodBigintAsString(),
    type: z.enum([
      pageElementTypes.enum.heading,
      pageElementTypes.enum.text,
      pageElementTypes.enum.code,
    ]),
    text: z.string(),
  }),
  z.object({
    id: zodBigintAsString(),
    type: z.enum([pageElementTypes.enum.image]),
    url: z.string().optional(),
    mode: z
      .union([
        z.literal(uploadModes.enum.file),
        z.literal(uploadModes.enum.url),
      ])
      .optional(),
  }),
  z.object({
    id: zodBigintAsString(),
    type: z.enum([pageElementTypes.enum.line, pageElementTypes.enum.spacing]),
  }),
  z.discriminatedUnion("buttonType", [
    z.object({
      id: zodBigintAsString(),
      type: z.literal(pageElementTypes.enum.button),
      label: z.string().min(1).max(20),
      buttonType: z.literal(buttonTypes.enum.sendMessage),
      beforeStep: startAnotherNodeStepSchema,
      steps: z.array(z.union(actionSteps)),
    }),
    z.object({
      id: zodBigintAsString(),
      type: z.literal(pageElementTypes.enum.button),
      label: z.string().min(1).max(20),
      buttonType: z.literal(buttonTypes.enum.openWebsite),
      beforeStep: openWebsiteStepSchema,
      steps: z.array(z.union(actionSteps)),
    }),
    z.object({
      id: zodBigintAsString(),
      type: z.literal(pageElementTypes.enum.button),
      label: z.string().min(1).max(20),
      buttonType: z.literal(buttonTypes.enum.performAction),
      beforeStep: startAnotherNodeStepSchema,
      steps: z.array(z.union(actionSteps)),
    }),
    z.object({
      id: zodBigintAsString(),
      type: z.literal(pageElementTypes.enum.button),
      label: z.string().min(1).max(20),
      buttonType: z.literal(buttonTypes.enum.startExternalFlow),
      beforeStep: startExternalFlowStepSchema,
      steps: z.array(z.union(actionSteps)),
    }),
    z.object({
      id: zodBigintAsString(),
      type: z.literal(pageElementTypes.enum.button),
      label: z.string().min(1).max(20),
      buttonType: z.literal(buttonTypes.enum.startExternalNode),
      beforeStep: startExternalNodeStepSchema,
      steps: z.array(z.union(actionSteps)),
    }),
    z.object({
      id: zodBigintAsString(),
      type: z.literal(pageElementTypes.enum.button),
      label: z.string().min(1).max(20),
      buttonType: z.literal(buttonTypes.enum.startAnotherNode),
      beforeStep: startAnotherNodeStepSchema,
      steps: z.array(z.union(actionSteps)),
    }),
    z.object({
      id: zodBigintAsString(),
      type: z.literal(pageElementTypes.enum.button),
      label: z.string().min(1).max(20),
      buttonType: z.literal(null),
      beforeStep: z.null(),
      steps: z.array(z.any()),
    }),
  ]),
])

export type PageElementSchema = z.infer<typeof pageElementSchema>

export const emailStepSchema = z.object({
  id: zodBigintAsString(),
  stepType: z.literal(stepTypes.enum.email),
  integrationSmtpId: z.string().trim(),
  topicId: z.string().trim().optional(),
  from: z.string().trim(),
  to: z.string().trim(),
  subject: z.string().trim(),
  preheader: z.string().trim(),
  /**
   * B2 (s220b): a saved EmailTemplate, or an inline EmailDocument
   * (@chatbotx.io/email-document, validated at send by parseDocument). Either
   * wins over `elements`; both optional / defaulted because saved flow
   * versions are re-parsed on publish.
   */
  templateId: zodBigintAsString().optional(),
  document: z.record(z.string(), z.unknown()).optional(),
  elements: z.array(pageElementSchema).default([]),
  /**
   * B2 phase 4 (s222b): send through a bulktext email LINE (an API-channel
   * inbox) instead of `integrationSmtpId`. The hub still renders; the line
   * relays the rendered mail to the contact's address on that inbox (its
   * ContactInbox sourceId), from the line's own address. Optional: saved
   * versions are re-parsed on publish.
   */
  lineInboxId: zodBigintAsString().optional(),
  /**
   * Outreach B-1 (s225b): `text` sends a line mail as text/plain only (no open
   * pixel, no signed links, no line marker) and, inside a sequence, threads
   * each step under the first one (`Re: <first subject>`). Honored only with
   * `lineInboxId`; an SMTP send is always `html`. Optional: saved versions are
   * re-parsed on publish.
   */
  format: z.enum(["html", "text"]).optional(),
  /**
   * Outreach B-1 PR 3 (s226b), honored only with `lineInboxId`: which earlier
   * mail on this line (with this contact) the step replies under.
   * `previous` = this sequence's (or broadcast's, or flow's) newest mail,
   * `campaign` = the newest mail of `threadCampaign`, `latest` = the newest
   * mail either way, including the contact's own; `none` = a new thread.
   * Unset keeps s225b: a text step in a sequence is `previous`, else `none`.
   * Every mode sees only mail recorded after s226b.
   */
  threadMode: z.enum(["previous", "campaign", "latest", "none"]).optional(),
  threadCampaign: z
    .union([
      z.strictObject({ sequenceId: zodBigintAsString() }),
      z.strictObject({ broadcastId: zodBigintAsString() }),
    ])
    .optional(),
  /** No earlier mail in scope: `new` (default) starts a thread, `stop` sends nothing and ends the contact's enrolment. */
  onNoThread: z.enum(["new", "stop"]).optional(),
})
export type EmailStepSchema = z.infer<typeof emailStepSchema>

export const UNSUBSCRIBE_PLACEHOLDER = "<<unsubscribeUrl>>"

export const emailStepDefaultFn = (
  props: Partial<EmailStepSchema> = {},
): EmailStepSchema => ({
  integrationSmtpId: "",
  topicId: "",
  from: "",
  to: "{{email}}",
  subject: "",
  preheader: "",
  elements: [
    {
      id: createId(),
      type: pageElementTypes.enum.text,
      text: `You received this email from {{page_user_name}}. If you would like to unsubscribe, <a href="${UNSUBSCRIBE_PLACEHOLDER}">click here</a>`,
    },
  ],
  ...props,
  id: createId(),
  stepType: stepTypes.enum.email,
})
