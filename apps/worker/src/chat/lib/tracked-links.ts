import {
  buildTrackedLinkUrl,
  buildTrackedPixelUrl,
  trackedLinkService,
} from "@chatbotx.io/business"
import { stepTypes } from "@chatbotx.io/flow-config"
import type { SendFlowStepData } from "@chatbotx.io/sdk"

/**
 * Every http(s) URL in a text. Trailing sentence punctuation is not part of
 * a URL a person typed ("see https://x.y/z." ends at "z"), so it is peeled
 * off after the match.
 */
const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'\])]+/g
const TRAILING_PUNCTUATION = /[.,;:!?]+$/

export type TrackedLinkMinter = (url: string) => Promise<string>

/**
 * Pure rewrite: replaces every URL in `text` with the short URL the minter
 * returns for it. URLs already under `${appUrl}/go/` are left alone so a
 * re-sent text is not double-wrapped. One token per occurrence, in order.
 */
export async function rewriteTrackedLinks(
  text: string,
  appUrl: string,
  mint: TrackedLinkMinter,
): Promise<{ text: string; minted: number }> {
  const trackedPrefix = buildTrackedLinkUrl(appUrl, "")
  let minted = 0
  let out = ""
  let last = 0
  for (const match of text.matchAll(HTTP_URL_PATTERN)) {
    const raw = match[0]
    const trailing = raw.match(TRAILING_PUNCTUATION)?.[0] ?? ""
    const url = trailing === "" ? raw : raw.slice(0, -trailing.length)
    const start = match.index ?? 0
    out += text.slice(last, start)
    if (url.startsWith(trackedPrefix)) {
      out += raw
    } else {
      out += buildTrackedLinkUrl(appUrl, await mint(url)) + trailing
      minted += 1
    }
    last = start + raw.length
  }
  out += text.slice(last)
  return { text: out, minted }
}

/**
 * The chat-worker hook: a `bulktextSend` step with `trackLinks` on gets its
 * rendered text rewritten before the envelope is built, so push callbacks,
 * the pull outbox and the stored Message all carry the short URLs; with
 * `trackOpens` on it gets a minted pixel URL in `openPixel`, which rides
 * `contentAttributes.bulktext` to the line worker. Any other step comes back
 * untouched. A mint failure throws: the operator opted in, so sending
 * untracked silently would defeat the option.
 */
export async function trackBulktextLinksInStep<
  T extends SendFlowStepData,
>(input: {
  step: T
  workspaceId: string
  contactId: string
  contactInboxId: string | null
  flowId: string | null
  appUrl: string
}): Promise<T> {
  const { step } = input
  if (step.stepType !== stepTypes.enum.bulktextSend) {
    return step
  }
  const wantLinks =
    "trackLinks" in step &&
    step.trackLinks === true &&
    typeof step.text === "string" &&
    step.text !== ""
  const wantOpens = "trackOpens" in step && step.trackOpens === true
  if (!(wantLinks || wantOpens)) {
    return step
  }
  const attribution = {
    workspaceId: input.workspaceId,
    contactId: input.contactId,
    contactInboxId: input.contactInboxId,
    flowId: input.flowId,
    stepId: step.id,
  }
  let next: T = step
  if (wantLinks) {
    const { text } = await rewriteTrackedLinks(
      step.text as string,
      input.appUrl,
      (url) => trackedLinkService.mint({ ...attribution, url }),
    )
    next = { ...next, text }
  }
  if (wantOpens) {
    const token = await trackedLinkService.mintPixel(attribution)
    next = { ...next, openPixel: buildTrackedPixelUrl(input.appUrl, token) }
  }
  return next
}
