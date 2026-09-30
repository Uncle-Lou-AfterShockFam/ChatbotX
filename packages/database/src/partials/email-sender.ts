import z from "zod"

/**
 * Mailbox senders (ManyReach step 3, s229b): the mailboxes an email LINE (an
 * API-channel inbox relayed by a bulktext daemon) sends from. The hub is the
 * registry and the sticky-sender record; the daemon does SMTP/IMAP per
 * mailbox, fed by `GET /v1/channels/api/senders`.
 */
export const emailSenderProviders = z.enum(["smtp", "google_oauth"])
export type EmailSenderProvider = z.infer<typeof emailSenderProviders>

/**
 * `disconnected` is set by the system only (a mailbox that stopped
 * authenticating); `archived` is terminal (a sender is never hard-deleted:
 * thread mails reference it).
 */
export const emailSenderStatuses = z.enum([
  "active",
  "paused",
  "draining",
  "disconnected",
  "archived",
])
export type EmailSenderStatus = z.infer<typeof emailSenderStatuses>

/** The statuses a user may set (`disconnected` / `archived` are not). */
export const emailSenderUserStatuses = z.enum(["active", "paused", "draining"])
export type EmailSenderUserStatus = z.infer<typeof emailSenderUserStatuses>

export const EMAIL_SENDER_LIMITS = {
  /** The feed's string cap (the daemon refuses longer). */
  string: 320,
  signature: 10_000,
  dailyLimit: { min: 1, max: 500, default: 25 },
  rampStart: { min: 1, max: 500 },
  rampPercent: { min: 1, max: 100 },
  minGapMinutes: { min: 0, max: 1440, default: 10 },
  /** Senders per line the feed returns (and a line may hold). */
  perLine: 50,
} as const

/** An EmailSender id as it travels (hub <-> daemon). */
export const EMAIL_SENDER_ID = /^\d{1,19}$/

/** Gmail with an app password (the UI preset). */
export const GMAIL_APP_PASSWORD_PRESET = {
  smtp: { host: "smtp.gmail.com", port: 465, secure: true },
  imap: { host: "imap.gmail.com", port: 993, secure: true, mailbox: "INBOX" },
} as const
