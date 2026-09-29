import { createHash } from "node:crypto"
import { contactInboxService, inboxService } from "@chatbotx.io/business"
import type { ContactInboxModel } from "@chatbotx.io/database/types"
import { uploader } from "@chatbotx.io/filesystem"
import type { LineEmail } from "@chatbotx.io/integration-api"
import { EmailContentError, type MailAttachment } from "./send-email-document"

/**
 * B2 phase 4 (s222b): the email step relayed by a bulktext email LINE (an
 * API-channel inbox) instead of hub SMTP. The hub renders exactly as for
 * SMTP; the line only transports. Its parser (bulktext
 * `src/email/document-mail.mjs`) enforces these SAME caps and refuses the
 * whole send past them, so the hub fails closed here first, before the
 * tracking row, instead of enqueueing a mail the line must refuse.
 */
export const LINE_EMAIL_LIMITS = {
  subject: 200,
  htmlBytes: 512 * 1024,
  textBytes: 128 * 1024,
  threadKeys: 20,
} as const

/**
 * A pull-mode row can wait in the outbox while the line is down; the line
 * downloads each attachment when it takes the row. 24 h covers a day's
 * outage; past it the download fails and the line refuses the send (visible
 * as a failed message), never a mail without its attachment.
 */
export const LINE_ATTACHMENT_URL_TTL_SECONDS = 24 * 60 * 60

// biome-ignore lint/suspicious/noControlCharactersInRegex: collapsing them
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g

/**
 * The line inbox and the contact's identity on it, checked BEFORE anything is
 * written: the inbox must be this workspace's API channel, and the contact
 * must already have a ContactInbox there (its sourceId IS the address the
 * line mails). Anything else is unusable content: failed closed, no retry.
 */
export async function resolveEmailLine(props: {
  workspaceId: string
  contactId: string
  lineInboxId: string
}): Promise<ContactInboxModel> {
  const inbox = await inboxService.find({
    where: { id: props.lineInboxId, workspaceId: props.workspaceId },
  })
  if (!inbox) {
    throw new EmailContentError(
      `email line ${props.lineInboxId} is not an inbox of this workspace`,
    )
  }
  if (inbox.channel !== "api") {
    throw new EmailContentError(
      `inbox ${props.lineInboxId} is a ${inbox.channel} inbox, not an email line`,
    )
  }
  const contactInbox = await contactInboxService.findByUncached({
    where: {
      contactId: props.contactId,
      inboxId: props.lineInboxId,
      channel: "api",
    },
  })
  if (!contactInbox?.sourceId?.includes("@")) {
    throw new EmailContentError(
      `contact ${props.contactId} has no email address on line ${props.lineInboxId}`,
    )
  }
  return contactInbox
}

/**
 * The rendered mail as the line receives it: a single-line subject, both
 * bodies within the caps, and each attachment as a signed download plus its
 * MEASURED size and sha256 (the line refuses a download that differs, and
 * caches by the hash). The line accepts downloads only from the hub's own
 * origin, so a storage base on another origin (S3_PUBLIC_UPLOAD_URL) fails
 * here with that reason, not as an opaque refusal at the line (skeptic
 * s222b). Throws EmailContentError past a cap.
 */
export async function buildLineEmail(props: {
  appUrl: string
  subject: string
  /** Absent for a `text` mail (s225b): the line refuses html there. */
  html?: string
  text: string
  headers: Record<string, string>
  attachments: MailAttachment[]
  format?: "html" | "text"
  messageKey?: string
  threadKeys?: string[]
}): Promise<LineEmail> {
  const format = props.format ?? "html"
  if (format === "html" && typeof props.html !== "string") {
    throw new EmailContentError("an html line mail needs its html body")
  }
  if (format === "text" && props.text.trim() === "") {
    throw new EmailContentError("a plain-text line mail needs a text body")
  }
  const threadKeys = props.threadKeys ?? []
  if (threadKeys.length > 0 && !props.messageKey) {
    throw new EmailContentError("a threaded line mail needs its own messageKey")
  }
  if (threadKeys.length > LINE_EMAIL_LIMITS.threadKeys) {
    throw new EmailContentError(
      `a line mail threads under at most ${LINE_EMAIL_LIMITS.threadKeys} earlier mails`,
    )
  }
  const subject = props.subject.replace(CONTROL_CHARS, " ").trim()
  if (subject === "" || subject.length > LINE_EMAIL_LIMITS.subject) {
    throw new EmailContentError(
      `the subject must be 1..${LINE_EMAIL_LIMITS.subject} characters for the email line`,
    )
  }
  const html = format === "html" ? (props.html as string) : ""
  if (Buffer.byteLength(html, "utf8") > LINE_EMAIL_LIMITS.htmlBytes) {
    throw new EmailContentError(
      `the rendered email exceeds ${LINE_EMAIL_LIMITS.htmlBytes} bytes, the email line's cap`,
    )
  }
  if (Buffer.byteLength(props.text, "utf8") > LINE_EMAIL_LIMITS.textBytes) {
    throw new EmailContentError(
      `the email's text part exceeds ${LINE_EMAIL_LIMITS.textBytes} bytes, the email line's cap`,
    )
  }
  const appOrigin = new URL(props.appUrl).origin
  const attachments = await Promise.all(
    props.attachments.map(async (a) => {
      const url = await uploader.getPresignedDownload(
        a.key,
        LINE_ATTACHMENT_URL_TTL_SECONDS,
      )
      if (new URL(url).origin !== appOrigin) {
        throw new EmailContentError(
          `attachments are served from ${new URL(url).origin}, but the email line only downloads from the hub (${appOrigin}): set S3_PUBLIC_UPLOAD_URL under the app URL`,
        )
      }
      return {
        url,
        name: a.filename,
        mimeType: a.contentType,
        size: a.content.length,
        sha256: createHash("sha256").update(a.content).digest("hex"),
      }
    }),
  )
  // A text mail carries no html key at all, and the html shape stays
  // byte-identical to before (no format / key fields) when unthreaded.
  return {
    ...(format === "text" ? { format } : { html }),
    subject,
    text: props.text,
    headers: props.headers,
    ...(props.messageKey ? { messageKey: props.messageKey } : {}),
    ...(threadKeys.length > 0 ? { threadKeys } : {}),
    attachments,
  }
}
