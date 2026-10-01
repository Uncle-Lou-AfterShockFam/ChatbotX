import type { BaseConfig, Context } from "@chatbotx.io/sdk"
import { customAuthSchema } from "@chatbotx.io/sdk"
import { z } from "zod"

export type ApiConfig = BaseConfig

/**
 * `callbackUrl` is duplicated with the `IntegrationApi.callbackUrl` column
 * deliberately: the column is what the settings UI reads/validates, this is
 * what the send path reads off `ctx.auth` without a second query.
 */
export const apiDeliveryModes = z.enum(["push", "pull"])
export type ApiDeliveryMode = z.infer<typeof apiDeliveryModes>

export const apiAuthSchema = customAuthSchema.extend({
  callbackUrl: z.url().nullish(),
  signingSecret: z.string().min(1),
  /**
   * `push` (default): every outbound envelope is POSTed to `callbackUrl`.
   * `pull` (fork, s164): envelopes are queued in `ApiChannelOutbox` and the
   * worker behind the inbox leases them through `GET /v1/channels/api/outbox`
   * - for a worker with no public URL (a laptop line). A `pull` inbox needs no
   * callback URL; a `push` inbox without one is inbound-only.
   */
  deliveryMode: apiDeliveryModes.nullish(),
  /**
   * Short links (fork, s170): every URL of `SHORT_LINK_MIN_LENGTH` or more in
   * an outbound text or URL quick reply is replaced by a tracked
   * `<appUrl>/go/<token>` link before the envelope leaves (push and pull
   * alike). Unset means ON: a text line has no room for a 1,200-character
   * signed booking URL, and clicks on the short form count as engagement.
   */
  shortenLinks: z.boolean().nullish(),
})
export type ApiAuthValue = z.infer<typeof apiAuthSchema>

/**
 * B2 phase 4 (s222b): a newsletter the hub rendered, relayed by a bulktext
 * email line as `contentAttributes.bulktext.email`. The line validates this
 * shape CLOSED with the same caps (bulktext `src/email/document-mail.mjs`);
 * attachments travel as signed downloads on the hub's own origin, never bytes.
 */
export type LineEmail = {
  /**
   * Outreach B-1 (s225b): `text` = text/plain only, and `html` is then ABSENT
   * (the line refuses it). Omitted = `html`, as before.
   */
  format?: "html" | "text"
  subject: string
  html?: string
  text: string
  headers: Record<string, string>
  /**
   * s225b: the Message-ID LOCAL part the hub minted (8..64 of [A-Za-z0-9._-]);
   * the line appends `@<its From domain>`. `threadKeys` are the earlier mails'
   * keys, root first (<= 20): References, the last one as In-Reply-To.
   */
  messageKey?: string
  threadKeys?: string[]
  /**
   * s226b: FOREIGN parents (the contact's own mail and what it cited), full
   * RFC msg-ids, oldest first; the line writes them before the threadKeys in
   * References. Needs `messageKey`; <= 20 ids with the threadKeys.
   */
  replyTo?: { references: string[] }
  /**
   * s229b: the EmailSender (mailbox) id to send from, a decimal bigint
   * string. ABSENT = the line's legacy env account; sent only when set, so a
   * line without senders never sees the key.
   */
  sender?: string
  /** `sha256` of the bytes: the line verifies the download and caches by it. */
  attachments: {
    url: string
    name: string
    mimeType: string
    size: number
    sha256: string
  }[]
}

export type ApiActions<IAuth extends ApiAuthValue = ApiAuthValue> = {
  sendEmail: (props: {
    ctx: Context<IAuth>
    contact: { id: string; sourceId: string }
    email: LineEmail
    /** The line's idempotency key for this send (<= 120 chars). */
    ref: string
    /**
     * s236: ISO instant; the line skips the queued mail at claim time
     * ('replied') when the contact WROTE back at/after it (bulktext
     * parseSendOptions + the runner's reply gate). Sent only when set.
     */
    skipIfRepliedSince?: string
  }) => Promise<{ messageIds: string[] }>
}
