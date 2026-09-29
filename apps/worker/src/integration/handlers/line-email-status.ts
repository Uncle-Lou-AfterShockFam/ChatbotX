import { emailTopicAnalyticsService } from "@chatbotx.io/analytics"
import { apiChannelOutboxService } from "@chatbotx.io/business"

/**
 * B2 phase 4 (s222b): the `ref` the email step gives a newsletter it hands to
 * a bulktext email line. `t:` carries the email-topic recipient token (the
 * line's final status settles it); `u:` is an untracked send (no topic).
 */
export const lineEmailRef = (token: string | undefined, fallback: string) =>
  token ? `email:t:${token}` : `email:u:${fallback}`

const TRACKED_REF = /^email:t:(.+)$/
const OUTBOX_ID = /^outbox:(.+)$/

/**
 * A pull-mode line's delivered / failed status (or its ack refusal, which
 * arrives as a failed status) for a queued newsletter settles the email-topic
 * recipient: the email step leaves it open at hand-off, because enqueueing is
 * not delivery and a failure can never overwrite a delivered row. Any other
 * status, message id or row is left alone. Returns whether it settled one.
 */
export async function settleLineEmailStatus(props: {
  inboxId: string
  messageId: string
  status: string
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
  const token = ref ? TRACKED_REF.exec(ref)?.[1] : undefined
  if (!token) {
    return false
  }
  await (props.status === "delivered"
    ? emailTopicAnalyticsService.markDelivered(token)
    : emailTopicAnalyticsService.markFailed(token))
  return true
}
