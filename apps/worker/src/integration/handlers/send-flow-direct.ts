import { contactInboxService, conversationService } from "@chatbotx.io/business"
import type { MetadataPayload } from "@chatbotx.io/flow-config"
import { getDispatchContactInboxes } from "@chatbotx.io/sequence-scheduler"
import { COMPANY_STOPPED } from "./company-stop-guard"
import { runFlowNode } from "./flow"

export interface SendFlowDirectParams {
  contactId: string
  /**
   * The inbox the dispatch was scheduled on. The flow runs on THAT inbox
   * only (owner s220b: one run per sequence step; a flow that must reach
   * several channels says so in its own steps). When it no longer belongs to
   * the contact, the contact's current dispatch inbox is used instead.
   */
  contactInboxId: string
  flowExecutionKey?: string
  flowId: string
  metadata?: MetadataPayload
  /** Enqueue time of the job running this dispatch (the run start). */
  startedAt?: Date
  workspaceId: string
}

/** `companyStopped`: every run ended on a company stop before sending anything. */
export async function sendFlowDirect(
  params: SendFlowDirectParams,
): Promise<{ companyStopped: boolean }> {
  const {
    flowExecutionKey,
    flowId,
    workspaceId,
    contactId,
    metadata,
    startedAt,
    contactInboxId,
  } = params

  const conversation = await conversationService.findBy({
    where: { contactId, workspaceId },
  })

  if (!conversation) {
    throw new Error(`Conversation not found for contact ${contactId}`)
  }

  const allContactInboxes = await contactInboxService.listByContactId({
    workspaceId,
    contactId,
  })
  const pinned = allContactInboxes.find((ci) => ci.id === contactInboxId)
  const targets = pinned
    ? [pinned]
    : await getDispatchContactInboxes(workspaceId, contactId)

  const outcomes = await Promise.all(
    targets.map(
      async (contactInbox) =>
        await runFlowNode(
          {
            flowId,
            metadata,
            conversationId: conversation,
            contactInboxId: contactInbox,
          },
          { flowExecutionKey, startedAt },
        ),
    ),
  )

  return {
    companyStopped:
      outcomes.length > 0 && outcomes.every((o) => o === COMPANY_STOPPED),
  }
}
