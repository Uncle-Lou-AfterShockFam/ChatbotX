import { companyService, contactService } from "@chatbotx.io/business"
import { stopCompanyForContact } from "@chatbotx.io/business/company-stop"
import type { MessageReceivedPayload } from "@chatbotx.io/event-bus"
import { logger } from "../../../lib/logger"

/**
 * Company stop rule, reply trigger. For every genuine inbound message
 * (`origin: "inbound"`; the delivery echo is skipped) the contact is first
 * auto-linked to the company owning its email domain, then its company, if
 * any, is stopped. Workspaces with no companies cost one cached count per
 * batch and nothing else. Each contact is handled once per batch; a failure
 * is logged and never blocks the other listeners.
 */
export async function handleCompanyStopOnReply(
  payloads: MessageReceivedPayload[],
): Promise<void> {
  const seen = new Set<string>()
  const companyCountByWorkspace = new Map<string, number>()

  for (const payload of payloads) {
    if (payload.origin !== "inbound" || seen.has(payload.contactId)) {
      continue
    }
    seen.add(payload.contactId)
    try {
      let companyCount = companyCountByWorkspace.get(payload.workspaceId)
      if (companyCount === undefined) {
        companyCount = await companyService.countForWorkspace({
          workspaceId: payload.workspaceId,
        })
        companyCountByWorkspace.set(payload.workspaceId, companyCount)
      }
      if (companyCount === 0) {
        continue
      }

      const contact = await contactService.findById({
        workspaceId: payload.workspaceId,
        id: payload.contactId,
      })
      if (!contact) {
        continue
      }

      if (!contact.companyId) {
        const email =
          contact.email ??
          (payload.sourceId?.includes("@") ? payload.sourceId : null)
        const linked = await companyService.autoLinkContact({
          workspaceId: payload.workspaceId,
          contactId: contact.id,
          email,
        })
        if (!linked.linked) {
          continue
        }
      }

      const result = await stopCompanyForContact({
        workspaceId: payload.workspaceId,
        contactId: contact.id,
        reason: "contact_replied",
      })
      if (result.status === "stopped") {
        logger.info(
          {
            workspaceId: payload.workspaceId,
            contactId: contact.id,
            companyId: result.companyId,
            contactCount: result.contactCount,
          },
          "company-stop: inbound reply stopped the company",
        )
      }
    } catch (err) {
      logger.warn(
        { err, workspaceId: payload.workspaceId, contactId: payload.contactId },
        "company-stop: reply handling failed; skipping payload",
      )
    }
  }
}
