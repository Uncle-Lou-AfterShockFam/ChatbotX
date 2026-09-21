import {
  buildTrackedPixelUrl,
  rewriteTrackedLinks,
  trackedLinkService,
} from "@chatbotx.io/business"

// The pure rewrite lives in the business package since s170 so the API
// channel can shorten links with the same rules; re-exported for callers.
export { rewriteTrackedLinks } from "@chatbotx.io/business"

import { stepTypes } from "@chatbotx.io/flow-config"
import type { SendFlowStepData } from "@chatbotx.io/sdk"

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
