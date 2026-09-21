import {
  buildTrackedLinkUrl,
  rewriteTrackedLinks,
  shouldRewriteUrl,
  trackedLinkService,
} from "@chatbotx.io/business"
import type { MessageButtonTemplate, OutgoingContact } from "@chatbotx.io/sdk"
import type { ApiAuthValue } from "../schema"

/**
 * A URL this long or longer is replaced by `<appUrl>/go/<token>` (42
 * characters on a short host). Below it the author's URL is already the
 * shorter, more legible form; above it a text line wraps the link across
 * bubbles and a signed booking URL (~1,200 characters) costs eight SMS
 * segments on its own.
 */
export const SHORT_LINK_MIN_LENGTH = 60

type ShortenContext = {
  auth: ApiAuthValue
  integrationDetail?: Record<string, unknown>
  platform?: { appUrl: string }
}

export type ShortenableEnvelope = {
  message: {
    text: string | null
    quickReplies?: MessageButtonTemplate[]
  }
}

/** Unset means on (see `apiAuthSchema.shortenLinks`). */
export const shortLinksEnabled = (auth: ApiAuthValue): boolean =>
  auth.shortenLinks !== false

const isUrlButton = (
  button: MessageButtonTemplate,
): button is Extract<MessageButtonTemplate, { buttonType: "url" }> =>
  button.buttonType === "url" && typeof button.url === "string"

const requireString = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") {
    throw new Error(
      `short links: ${what} is missing; cannot mint a tracked link`,
    )
  }
  return value
}

/**
 * The single choke point both API-channel senders pass through before the
 * envelope is posted (push) or queued (pull): every qualifying URL in the
 * message text and in URL quick replies becomes a tracked short link minted
 * against the contact, so the `/go/[token]` route's click marks
 * (`bt-clicked`, `bt_last_click`) apply to the shortened link too.
 *
 * Nothing to shorten (or the channel opted out) returns the envelope as is
 * without touching the ids. A candidate with no attribution or a failing
 * mint throws: the line would otherwise silently send the long
 * form the operator asked to avoid. `contentAttributes` (attachments, the
 * open pixel, template payloads) is deliberately not rewritten.
 */
export async function shortenEnvelopeLinks<
  E extends ShortenableEnvelope,
>(input: {
  ctx: ShortenContext
  contact: OutgoingContact
  envelope: E
  flowId?: string | null
  stepId?: string | null
}): Promise<E> {
  const { ctx, contact, envelope } = input
  if (!shortLinksEnabled(ctx.auth)) {
    return envelope
  }
  const appUrl = ctx.platform?.appUrl
  if (typeof appUrl !== "string" || appUrl === "") {
    // No app URL means no public /go/ host to point at; nothing can be
    // shortened, whether or not the text carries a URL.
    return envelope
  }

  // Attribution resolves on the FIRST mint, so an envelope with nothing to
  // shorten never asks a bare (inbound-only, test) context for ids it does
  // not carry, and one with a candidate fails before anything is posted.
  let attribution: {
    workspaceId: string
    contactId: string
    contactInboxId: string
    flowId: string | null
    stepId: string | null
  } | null = null
  const mint = (url: string) => {
    attribution ??= {
      workspaceId: requireString(
        ctx.integrationDetail?.workspaceId,
        "the integration row's workspace id",
      ),
      contactId: requireString(contact.contactId, "the contact id"),
      contactInboxId: contact.id,
      flowId: input.flowId ?? null,
      stepId: input.stepId ?? null,
    }
    return trackedLinkService.mint({ ...attribution, url })
  }
  const options = { minLength: SHORT_LINK_MIN_LENGTH }

  const text =
    typeof envelope.message.text === "string"
      ? (
          await rewriteTrackedLinks(
            envelope.message.text,
            appUrl,
            mint,
            options,
          )
        ).text
      : envelope.message.text

  const quickReplies =
    envelope.message.quickReplies === undefined
      ? undefined
      : await Promise.all(
          envelope.message.quickReplies.map(async (button) =>
            isUrlButton(button) && shouldRewriteUrl(button.url, appUrl, options)
              ? {
                  ...button,
                  url: buildTrackedLinkUrl(appUrl, await mint(button.url)),
                }
              : button,
          ),
        )

  return {
    ...envelope,
    message: { ...envelope.message, text, quickReplies },
  }
}
