import { contactSequenceService } from "@chatbotx.io/business/contact-sequence"
import type { MessageReceivedPayload } from "@chatbotx.io/event-bus"
import { logger } from "../../../lib/logger"

/**
 * Sequence stop rule, reply trigger (s220b). A genuine inbound message
 * (`origin: "inbound"`; the delivery echo is skipped) ends the contact's
 * enrolment in every sequence that has `stopOnReply` on. Each contact is
 * handled once per batch; a failure is logged and never blocks the other
 * listeners.
 */
export async function handleSequenceStopOnReply(
  payloads: MessageReceivedPayload[],
): Promise<void> {
  const seen = new Set<string>()

  for (const payload of payloads) {
    const key = `${payload.workspaceId}:${payload.contactId}`
    if (payload.origin !== "inbound" || seen.has(key)) {
      continue
    }
    seen.add(key)
    try {
      const sequenceIds =
        await contactSequenceService.removeStopOnReplyEnrollments({
          workspaceId: payload.workspaceId,
          contactId: payload.contactId,
          contactInboxId: payload.contactInboxId,
        })
      if (sequenceIds.length > 0) {
        logger.info(
          {
            workspaceId: payload.workspaceId,
            contactId: payload.contactId,
            sequenceIds,
          },
          "sequence-stop: inbound reply ended the contact's enrolments",
        )
      }
    } catch (err) {
      logger.warn(
        { err, workspaceId: payload.workspaceId, contactId: payload.contactId },
        "sequence-stop: reply handling failed; skipping payload",
      )
    }
  }
}
