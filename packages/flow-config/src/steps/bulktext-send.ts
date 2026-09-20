import { createId } from "@chatbotx.io/utils"
import { z } from "zod"
import { baseStepSchema } from "./base"
import { stepTypes } from "./step-action"

/**
 * "Text via bulktext": a send step for an API-channel inbox served by a
 * bulktext line worker (GV, iMessage, email). The text and photo travel in
 * the ordinary API-channel envelope; the remaining fields are delivery
 * options the worker applies at claim time (`contentAttributes.bulktext`).
 *
 * Every string field may carry `{{variable}}` tokens: the chat worker
 * resolves them against the contact before the envelope is built, so a
 * per-contact datetime field can drive `scheduleAt`.
 */
export const MAX_BULKTEXT_TEXT_LENGTH = 1000
export const MAX_BULKTEXT_REF_LENGTH = 120
export const MAX_BULKTEXT_SPREAD_MINUTES = 1440

const HTTPS_URL = /^https:\/\/\S+$/

const hasVariableToken = (value: string) => value.includes("{{")

const isIsoDateTime = (value: string) => !Number.isNaN(Date.parse(value))

export const bulktextSendStepSchema = baseStepSchema
  .extend({
    stepType: z.literal(stepTypes.enum.bulktextSend),
    text: z.string().trim().max(MAX_BULKTEXT_TEXT_LENGTH),
    /** https URL of a photo to attach; empty = none. */
    photoUrl: z.string().trim().max(2048),
    /** Idempotency key at the worker (per line + recipient); empty = content dedup. */
    ref: z.string().trim().max(MAX_BULKTEXT_REF_LENGTH),
    /** A dry send runs the worker's whole pipeline but leaves no text. */
    dryRun: z.boolean(),
    /** ISO 8601 (or a variable token) to send at; empty = now. */
    scheduleAt: z.string().trim().max(64),
    /** Spread the send over 1..1440 minutes; 0 = off. Exclusive with scheduleAt. */
    spreadOverMinutes: z.number().int().min(0).max(MAX_BULKTEXT_SPREAD_MINUTES),
    /** Skip when the contact replied on any line since this ISO instant; empty = off. */
    skipIfRepliedSince: z.string().trim().max(64),
    /**
     * Replace every URL in the text with a short hub link (`/l/<token>`) so a
     * tap can be recorded on the contact (tag `bt-clicked`, field
     * `bt_last_click`). Hub-side only: the worker never sees this option.
     */
    trackLinks: z.boolean().default(false),
    /**
     * Email line only: mint an open beacon and let the line worker append it
     * to the mail as a 1x1 image (`/go/<token>/o`); a fetch tags the contact
     * `bt-opened` and sets `bt_last_open`. On a text line it is ignored by the
     * worker's adapter.
     */
    trackOpens: z.boolean().default(false),
    /**
     * Filled by the chat worker when `trackOpens` is on: the minted pixel URL
     * that travels to the line worker as the `openPixel` option. Never set by
     * hand; empty = none.
     */
    openPixel: z.string().trim().max(2048).default(""),
  })
  .superRefine((data, ctx) => {
    if (data.text === "" && data.photoUrl === "") {
      ctx.addIssue({
        code: "custom",
        path: ["text"],
        message: "Text or a photo URL is required",
      })
    }
    if (
      data.photoUrl !== "" &&
      !hasVariableToken(data.photoUrl) &&
      !HTTPS_URL.test(data.photoUrl)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["photoUrl"],
        message: "Photo URL must be an https URL",
      })
    }
    if (data.scheduleAt !== "" && data.spreadOverMinutes > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["spreadOverMinutes"],
        message: "Schedule at and spread over are exclusive: pick one",
      })
    }
    for (const key of ["scheduleAt", "skipIfRepliedSince"] as const) {
      const value = data[key]
      if (value !== "" && !hasVariableToken(value) && !isIsoDateTime(value)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Must be an ISO 8601 date-time or a variable",
        })
      }
    }
  })

export type BulktextSendStepSchema = z.infer<typeof bulktextSendStepSchema>

export const bulktextSendStepDefaultFn = (
  props: Partial<BulktextSendStepSchema> = {},
): BulktextSendStepSchema => ({
  text: "",
  photoUrl: "",
  ref: "",
  dryRun: true,
  scheduleAt: "",
  spreadOverMinutes: 0,
  skipIfRepliedSince: "",
  trackLinks: false,
  trackOpens: false,
  openPixel: "",
  ...props,
  id: createId(),
  stepType: stepTypes.enum.bulktextSend,
})

/**
 * The delivery options as the worker reads them from
 * `contentAttributes.bulktext`: empty strings and a zero spread are omitted
 * so the envelope carries only what was set. `trackLinks` / `trackOpens` are
 * deliberately NOT here: the rewrite and the pixel mint happen in the chat
 * worker before the envelope is built, and bulktext refuses any option it
 * does not know (`bad-options`); `openPixel` IS an option the worker knows.
 */
export const bulktextSendOptions = (step: BulktextSendStepSchema) => ({
  dryRun: step.dryRun,
  ...(step.ref === "" ? {} : { ref: step.ref }),
  ...(step.scheduleAt === "" ? {} : { scheduleAt: step.scheduleAt }),
  ...(step.spreadOverMinutes > 0
    ? { spreadOverMinutes: step.spreadOverMinutes }
    : {}),
  ...(step.skipIfRepliedSince === ""
    ? {}
    : { skipIfRepliedSince: step.skipIfRepliedSince }),
  ...(step.openPixel === "" ? {} : { openPixel: step.openPixel }),
})
