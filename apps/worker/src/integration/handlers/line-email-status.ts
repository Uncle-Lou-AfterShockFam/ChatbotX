import { emailTopicAnalyticsService } from "@chatbotx.io/analytics"
import { apiChannelOutboxService } from "@chatbotx.io/business"
import { emailSuppressionService } from "@chatbotx.io/business/email-suppression"
import { parseEmailSuppression } from "@chatbotx.io/database/partials"
import { logger } from "../../lib/logger"
import { bulktextVerdictFor } from "./bulktext-verdict"

/**
 * B2 phase 4 (s222b): the `ref` the email step gives a newsletter it hands to
 * a bulktext email line. `t:` carries the email-topic recipient token (the
 * line's final status settles it); `u:` is an untracked send (no topic).
 */
export const lineEmailRef = (token: string | undefined, fallback: string) =>
  token ? `email:t:${token}` : `email:u:${fallback}`

const TRACKED_REF = /^email:t:(.+)$/
const EMAIL_REF = /^email:[tu]:/
const OUTBOX_ID = /^outbox:(.+)$/

/**
 * A pull-mode line's delivered / failed status (or its ack refusal, which
 * arrives as a failed status) for a queued newsletter settles the email-topic
 * recipient: the email step leaves it open at hand-off, because enqueueing is
 * not delivery and a failure can never overwrite a delivered row. Any other
 * status, message id or row is left alone. Returns whether it settled one.
 *
 * Outreach B-1 (s224b): a failure whose reason is an UNREACHABLE verdict
 * (bounce, bad address, complaint) on any email ref, tracked or not, also
 * suppresses the recipient address for the workspace. Only email refs reach
 * this, so an SMS line's bad number never suppresses an address.
 */
export async function settleLineEmailStatus(props: {
  workspaceId: string
  inboxId: string
  messageId: string
  status: string
  error?: unknown
  recipient?: unknown
}): Promise<boolean> {
  if (props.status !== "delivered" && props.status !== "failed") {
    return false
  }
  const outboxId = OUTBOX_ID.exec(props.messageId)?.[1]
  if (!outboxId) {
    return false
  }
  const ref = await apiChannelOutboxService.newsletterRef({
    inboxId: props.inboxId,
    id: outboxId,
  })
  if (!(ref && EMAIL_REF.test(ref))) {
    return false
  }
  if (
    bulktextVerdictFor(props.status, props.error)?.verdict === "unreachable"
  ) {
    await suppressUnreachable({
      workspaceId: props.workspaceId,
      recipient: props.recipient,
      ref,
    })
  }
  const token = TRACKED_REF.exec(ref)?.[1]
  if (!token) {
    return false
  }
  await (props.status === "delivered"
    ? emailTopicAnalyticsService.markDelivered(token)
    : emailTopicAnalyticsService.markFailed(token))
  return true
}

async function suppressUnreachable(props: {
  workspaceId: string
  recipient: unknown
  ref: string
}): Promise<void> {
  const parsed = parseEmailSuppression(props.recipient)
  if (!parsed.ok || parsed.kind !== "address") {
    logger.warn(
      { workspaceId: props.workspaceId, ref: props.ref },
      "line email unreachable, but its recipient is not one address: not suppressed",
    )
    return
  }
  await emailSuppressionService.add({
    workspaceId: props.workspaceId,
    value: parsed.value,
    reason: "unreachable",
    source: props.ref,
  })
}
