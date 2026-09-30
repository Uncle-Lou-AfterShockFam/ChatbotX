import { encryptedDataSchema, encryptUtils } from "@chatbotx.io/encryption"
import { z } from "zod"

/**
 * The credential blob of an `smtp` EmailSender (ManyReach step 3, s229b):
 * the mailbox's SMTP (send) and IMAP (read) logins. Stored ONLY encrypted
 * (`EmailSender.secret`); it leaves the business layer only through the
 * line's credential feed. Closed and bounded like the daemon's own check.
 */
export const secretHost = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.-]+$/, "Invalid host")
export const secretPort = z.number().int().min(1).max(65_535)
export const secretUser = z.string().trim().min(1).max(320)
const password = z.string().min(1).max(320)

export const emailSenderSmtpSecretSchema = z
  .object({
    smtp: z
      .object({
        host: secretHost,
        port: secretPort,
        secure: z.boolean(),
        user: secretUser,
        password,
      })
      .strict(),
    imap: z
      .object({
        host: secretHost,
        port: secretPort,
        secure: z.boolean(),
        user: secretUser,
        password,
        mailbox: z.string().trim().min(1).max(320),
      })
      .strict(),
  })
  .strict()
export type EmailSenderSmtpSecret = z.infer<typeof emailSenderSmtpSecretSchema>

/** AAD binds the ciphertext to its row: a blob copied to another row fails. */
export const emailSenderAad = (senderId: string) => `email-sender:${senderId}`

export const encryptEmailSenderSecret = async (
  secret: EmailSenderSmtpSecret,
  senderId: string,
) =>
  await encryptUtils.encryptObject(
    emailSenderSmtpSecretSchema.parse(secret),
    emailSenderAad(senderId),
  )

/** Throws on a blob of another row (AAD), a tampered blob or a wrong shape. */
export const decryptEmailSenderSecret = async (row: {
  id: string
  secret: unknown
}): Promise<EmailSenderSmtpSecret> =>
  await encryptUtils.decryptObject(
    encryptedDataSchema.parse(row.secret),
    emailSenderSmtpSecretSchema,
    emailSenderAad(row.id),
  )

/** The secret minus both passwords: what the UI may see. */
export type EmailSenderConnection = {
  smtp: Omit<EmailSenderSmtpSecret["smtp"], "password">
  imap: Omit<EmailSenderSmtpSecret["imap"], "password">
}

export function connectionOf(
  secret: EmailSenderSmtpSecret,
): EmailSenderConnection {
  const { password: _smtp, ...smtp } = secret.smtp
  const { password: _imap, ...imap } = secret.imap
  return { smtp, imap }
}
