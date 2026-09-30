import { replyClassificationService } from "@chatbotx.io/business/reply-classification"
import type { MessageReceivedPayload } from "@chatbotx.io/event-bus"
import { logger } from "../../../lib/logger"

/**
 * s228b outreach step 2 (rules first): an automatic answer the email line
 * flagged (ooo / auto) is recorded as the contact's reply classification,
 * for contacts in an outreach sequence. Each message once; a failure is
 * logged and never blocks the other listeners.
 */
export async function handleReplyClassificationRule(
  payloads: MessageReceivedPayload[],
): Promise<void> {
  const seen = new Set<string>()
  for (const payload of payloads) {
    const key = `${payload.workspaceId}:${payload.messageId ?? payload.contactId}`
    if (payload.origin !== "inbound" || !payload.autoReply || seen.has(key)) {
      continue
    }
    seen.add(key)
    try {
      await replyClassificationService.classifyReply({
        workspaceId: payload.workspaceId,
        contactId: payload.contactId,
        class: payload.autoReply,
        source: "rule",
        messageId: payload.messageId ?? null,
      })
    } catch (err) {
      logger.warn(
        { err, workspaceId: payload.workspaceId, contactId: payload.contactId },
        "reply-classification: recording the rule class failed",
      )
    }
  }
}
