import { contactSequenceService } from "@chatbotx.io/business/contact-sequence"
import type { MessageReceivedPayload } from "@chatbotx.io/event-bus"
import { logger } from "../../../lib/logger"

/**
 * Outreach B-1 (s226b, owner s223b): an out-of-office answer (flagged by the
 * bulktext email line) PAUSES the contact's stop-on-reply enrolments for 14
 * days instead of ending them; sequence-stop-on-reply skips it. Each contact
 * once per batch; a failure is logged and never blocks the other listeners.
 */
export async function handleSequenceOooPause(
  payloads: MessageReceivedPayload[],
): Promise<void> {
  const seen = new Set<string>()

  for (const payload of payloads) {
    const key = `${payload.workspaceId}:${payload.contactId}`
    if (
      payload.origin !== "inbound" ||
      payload.autoReply !== "ooo" ||
      seen.has(key)
    ) {
      continue
    }
    seen.add(key)
    try {
      const sequenceIds = await contactSequenceService.pauseForAutoReply({
        workspaceId: payload.workspaceId,
        contactId: payload.contactId,
        occurredAt: new Date(payload.occurredAt),
      })
      if (sequenceIds.length > 0) {
        logger.info(
          {
            workspaceId: payload.workspaceId,
            contactId: payload.contactId,
            sequenceIds,
          },
          "sequence-ooo: an out-of-office paused the contact's enrolments",
        )
      }
    } catch (err) {
      logger.warn(
        { err, workspaceId: payload.workspaceId, contactId: payload.contactId },
        "sequence-ooo: pause failed; skipping payload",
      )
    }
  }
}
