import {
  emailSenderUserStatuses,
  EMAIL_SENDER_LIMITS as L,
  parseEmailSuppression,
} from "@chatbotx.io/database/partials"
import { z } from "zod"
import { validationException } from "../errors"
import {
  imapPort,
  noControlChars,
  secretHost,
  secretMailbox,
  secretUser,
  smtpPort,
} from "./secret"

/** Closed input schemas of the EmailSender service (ManyReach step 3, s229b). */

const bigintId = z.string().regex(/^\d{1,19}$/, "Invalid id")

/** One single address, trimmed and lower-cased (the suppression parser). */
const emailAddress = z.string().transform((value, ctx) => {
  const parsed = parseEmailSuppression(value)
  if (!(parsed.ok && parsed.kind === "address" && noControlChars(value))) {
    ctx.addIssue({ code: "custom", message: "Enter a valid email address" })
    return z.NEVER
  }
  return parsed.value
})

/** Identity fields end up in From / headers: no control characters (CR/LF). */
const name = z
  .string()
  .trim()
  .min(1)
  .max(L.string)
  .refine(noControlChars, "Remove control characters")
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v?.trim() ? v.trim() : null))
const optionalEmail = z
  .string()
  .nullish()
  .transform((v, ctx) => {
    if (!v?.trim()) {
      return null
    }
    const parsed = parseEmailSuppression(v)
    if (!(parsed.ok && parsed.kind === "address" && noControlChars(v))) {
      ctx.addIssue({ code: "custom", message: "Enter a valid email address" })
      return z.NEVER
    }
    return parsed.value
  })

const int = (range: { min: number; max: number }) =>
  z.number().int().min(range.min).max(range.max)

const host = secretHost
const user = secretUser

const connectionInput = <P extends z.ZodType<string | undefined>>(
  password: P,
) =>
  z
    .object({
      smtp: z
        .object({ host, port: smtpPort, secure: z.boolean(), user, password })
        .strict(),
      imap: z
        .object({
          host,
          port: imapPort,
          secure: z.boolean(),
          user,
          password,
          mailbox: secretMailbox.default("INBOX"),
        })
        .strict(),
    })
    .strict()

/**
 * A new password is required on create. On update a blank or WHITESPACE-ONLY
 * one keeps the stored password (review s229b: it must neither replace it
 * nor reconnect the sender). Otherwise stored exactly as given: an app
 * password may be pasted with spaces.
 */
const isBlank = (v: string) => v.trim() === ""
const requiredPassword = z
  .string()
  .max(L.string)
  .refine((v) => !isBlank(v), "Enter the password")
const keptPassword = z
  .string()
  .max(L.string)
  .optional()
  .transform((v) => (v === undefined || isBlank(v) ? undefined : v))

const pacing = {
  dailyLimit: int(L.dailyLimit),
  rampStart: int(L.rampStart).nullable(),
  rampPercent: int(L.rampPercent).nullable(),
  minGapMinutes: int(L.minGapMinutes),
}

const rampBothOrNeither = (v: {
  rampStart?: number | null
  rampPercent?: number | null
}) =>
  v.rampStart === undefined ||
  v.rampPercent === undefined ||
  (v.rampStart === null) === (v.rampPercent === null)
const RAMP_MESSAGE = {
  message: "Set both the ramp start and the ramp percent, or neither",
  path: ["rampPercent"],
}

export const createEmailSenderInput = z
  .object({
    workspaceId: bigintId,
    lineInboxId: bigintId,
    /** `google_oauth` senders are connected by the OAuth flow (PR 3), never here. */
    provider: z.literal("smtp"),
    address: emailAddress,
    fromName: name,
    firstName: name,
    lastName: name,
    replyTo: optionalEmail,
    signature: optionalText(L.signature),
    dailyLimit: pacing.dailyLimit.default(L.dailyLimit.default),
    rampStart: pacing.rampStart.default(null),
    rampPercent: pacing.rampPercent.default(null),
    minGapMinutes: pacing.minGapMinutes.default(L.minGapMinutes.default),
    connection: connectionInput(requiredPassword),
  })
  .strict()
  .refine(rampBothOrNeither, RAMP_MESSAGE)

/** Address, provider and line are fixed: archive and add a new sender instead. */
export const updateEmailSenderInput = z
  .object({
    workspaceId: bigintId,
    id: bigintId,
    fromName: name.optional(),
    firstName: name.optional(),
    lastName: name.optional(),
    replyTo: optionalEmail.optional(),
    signature: optionalText(L.signature).optional(),
    dailyLimit: pacing.dailyLimit.optional(),
    rampStart: pacing.rampStart.optional(),
    rampPercent: pacing.rampPercent.optional(),
    minGapMinutes: pacing.minGapMinutes.optional(),
    connection: connectionInput(keptPassword).optional(),
  })
  .strict()
  .refine(rampBothOrNeither, RAMP_MESSAGE)

export const emailSenderRefInput = z
  .object({ workspaceId: bigintId, id: bigintId })
  .strict()

export const setEmailSenderStatusInput = z
  .object({
    workspaceId: bigintId,
    id: bigintId,
    status: emailSenderUserStatuses,
  })
  .strict()

export const listEmailSendersInput = z
  .object({ workspaceId: bigintId, lineInboxId: bigintId.optional() })
  .strict()

export const emailSenderLineInput = z
  .object({ workspaceId: bigintId, lineInboxId: bigintId })
  .strict()

/**
 * Parses a service entry point's input: null, a wrong type, an unknown key
 * or an out-of-range value is a 422 naming the first bad field. The message
 * never echoes the input (it may hold a password).
 */
export function parseInput<S extends z.ZodType>(
  schema: S,
  input: unknown,
): z.output<S> {
  const result = schema.safeParse(input)
  if (result.success) {
    return result.data
  }
  const issue = result.error.issues[0]
  const field = issue?.path.map(String).join(".") || "input"
  throw validationException(field, issue?.message ?? "Invalid input")
}
