import {
  emailSenderProviders,
  emailSenderStatuses,
  emailSenderUserStatuses,
  EMAIL_SENDER_LIMITS as L,
} from "@chatbotx.io/database/partials"
import z from "zod"

/**
 * Mailbox senders (ManyReach step 3, s229b). What the UI sees of a sender:
 * never the encrypted secret, never a password. The request bodies only
 * bound the shape; the service parses them CLOSED (one validator).
 */
const connectionView = z.object({
  smtp: z.object({
    host: z.string(),
    port: z.number(),
    secure: z.boolean(),
    user: z.string(),
  }),
  imap: z.object({
    host: z.string(),
    port: z.number(),
    secure: z.boolean(),
    user: z.string(),
    mailbox: z.string(),
  }),
})

export const emailSenderResource = z.object({
  id: z.string(),
  lineInboxId: z.string(),
  provider: emailSenderProviders,
  address: z.string(),
  fromName: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  replyTo: z.string().nullable(),
  signature: z.string().nullable(),
  dailyLimit: z.number(),
  rampStart: z.number().nullable(),
  rampPercent: z.number().nullable(),
  minGapMinutes: z.number(),
  status: emailSenderStatuses,
  disconnectionReason: z.string().nullable(),
  connection: connectionView.nullable(),
  createdAt: z.date(),
})
export type EmailSenderResource = z.infer<typeof emailSenderResource>

export const emailSenderLineResource = z.object({
  id: z.string(),
  name: z.string(),
})

const bounded = z.string().max(L.signature + 16)
const connectionData = z
  .object({
    smtp: z
      .object({
        host: z.string().max(260),
        port: z.number(),
        secure: z.boolean(),
        user: z.string().max(L.string + 16),
        password: z
          .string()
          .max(L.string + 16)
          .optional(),
      })
      .strict(),
    imap: z
      .object({
        host: z.string().max(260),
        port: z.number(),
        secure: z.boolean(),
        user: z.string().max(L.string + 16),
        password: z
          .string()
          .max(L.string + 16)
          .optional(),
        mailbox: z
          .string()
          .max(L.string + 16)
          .optional(),
      })
      .strict(),
  })
  .strict()

const senderFields = {
  fromName: z.string().max(L.string + 16),
  firstName: z.string().max(L.string + 16),
  lastName: z.string().max(L.string + 16),
  replyTo: z
    .string()
    .max(L.string + 16)
    .nullish(),
  signature: bounded.nullish(),
  dailyLimit: z.number().optional(),
  rampStart: z.number().nullish(),
  rampPercent: z.number().nullish(),
  minGapMinutes: z.number().optional(),
}

export const createEmailSenderData = z
  .object({
    lineInboxId: z.string().max(32),
    provider: z.literal("smtp"),
    address: z.string().max(L.string + 16),
    ...senderFields,
    connection: connectionData,
  })
  .strict()

export const updateEmailSenderData = z
  .object({
    id: z.string().max(32),
    fromName: senderFields.fromName.optional(),
    firstName: senderFields.firstName.optional(),
    lastName: senderFields.lastName.optional(),
    replyTo: senderFields.replyTo,
    signature: senderFields.signature,
    dailyLimit: senderFields.dailyLimit,
    rampStart: senderFields.rampStart,
    rampPercent: senderFields.rampPercent,
    minGapMinutes: senderFields.minGapMinutes,
    connection: connectionData.optional(),
  })
  .strict()

export const setEmailSenderStatusData = z
  .object({ id: z.string().max(32), status: emailSenderUserStatuses })
  .strict()
