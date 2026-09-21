import type { BaseConfig } from "@chatbotx.io/sdk"
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

export type ApiActions = Record<string, never>
