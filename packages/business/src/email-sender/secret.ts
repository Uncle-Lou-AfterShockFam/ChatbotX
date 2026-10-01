import { isIP } from "node:net"
import { encryptedDataSchema, encryptUtils } from "@chatbotx.io/encryption"
import { z } from "zod"
import { isBlockedIp } from "../net/ssrf-guard"

/**
 * The credential blob of an `smtp` EmailSender (ManyReach step 3, s229b):
 * the mailbox's SMTP (send) and IMAP (read) logins. Stored ONLY encrypted
 * (`EmailSender.secret`); it leaves the business layer only through the
 * line's credential feed. Closed and bounded like the daemon's own check.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
/** A numeric last label reads as an IPv4 shorthand to some resolvers. */
const NUMERIC = /^\d+$/

/** Refuses control characters (CR/LF header injection, NUL). */
export const noControlChars = (value: string) => !CONTROL_CHARS.test(value)

/**
 * A mail server host the hub accepts at write time (review s229b; the line
 * still vets and pins at connect time): a public IP literal, or a dotted DNS
 * name of valid labels whose last label is not numeric. Refused: private /
 * loopback / link-local / CGNAT / unspecified / reserved IPs (IPv4 and
 * IPv6, via the SSRF guard's ranges), `localhost` and `*.localhost`,
 * single-label names, empty or hyphen-edged labels.
 */
export function isAllowedMailHost(input: string): boolean {
  const host = input.toLowerCase()
  if (isIP(host) !== 0) {
    return !isBlockedIp(host)
  }
  if (
    host.length > 253 ||
    host === "localhost" ||
    host.endsWith(".localhost")
  ) {
    return false
  }
  const labels = host.split(".")
  return (
    labels.length >= 2 &&
    labels.every((label) => HOST_LABEL.test(label)) &&
    !NUMERIC.test(labels.at(-1) ?? "")
  )
}

export const secretHost = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine(isAllowedMailHost, "Enter a public mail server host name")
  .transform((host) => host.toLowerCase())
/** Submission / implicit TLS / alternate submission ports only. */
export const SMTP_PORTS = [25, 465, 587, 2525] as const
export const IMAP_PORTS = [143, 993] as const
const portOf = (ports: readonly number[]) =>
  z
    .number()
    .int()
    .refine((port) => ports.includes(port), `Use port ${ports.join(", ")}`)
export const smtpPort = portOf(SMTP_PORTS)
export const imapPort = portOf(IMAP_PORTS)
export const secretUser = z
  .string()
  .trim()
  .min(1)
  .max(320)
  .refine(noControlChars, "Remove control characters")
export const secretMailbox = z
  .string()
  .trim()
  .min(1)
  .max(320)
  .refine(noControlChars, "Remove control characters")
const password = z.string().min(1).max(320)

export const emailSenderSmtpSecretSchema = z
  .object({
    smtp: z
      .object({
        host: secretHost,
        port: smtpPort,
        secure: z.boolean(),
        user: secretUser,
        password,
      })
      .strict(),
    imap: z
      .object({
        host: secretHost,
        port: imapPort,
        secure: z.boolean(),
        user: secretUser,
        password,
        mailbox: secretMailbox,
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

/**
 * The credential blob of a `google_oauth` EmailSender (s230b): the Google
 * refresh token plus the last access token minted from it. `clientId` and
 * `ownerId` name the Google app that issued the grant (a refresh must use
 * the same app; another one means a reconnect). Same AAD as smtp.
 */
export const emailSenderGoogleSecretSchema = z
  .object({
    refreshToken: z.string().min(1).max(2048),
    accessToken: z.string().min(1).max(2048),
    /** Epoch ms. */
    expiresAt: z.number().int(),
    scope: z.string().max(2048),
    clientId: z.string().min(1).max(512),
    ownerId: z.string().min(1).max(64),
  })
  .strict()
export type EmailSenderGoogleSecret = z.infer<
  typeof emailSenderGoogleSecretSchema
>

export const encryptEmailSenderGoogleSecret = async (
  secret: EmailSenderGoogleSecret,
  senderId: string,
) =>
  await encryptUtils.encryptObject(
    emailSenderGoogleSecretSchema.parse(secret),
    emailSenderAad(senderId),
  )

export const decryptEmailSenderGoogleSecret = async (row: {
  id: string
  secret: unknown
}): Promise<EmailSenderGoogleSecret> =>
  await encryptUtils.decryptObject(
    encryptedDataSchema.parse(row.secret),
    emailSenderGoogleSecretSchema,
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
