import { contactInboxService, conversationService } from "@chatbotx.io/business"
import type { MetadataPayload } from "@chatbotx.io/flow-config"
import { COMPANY_STOPPED } from "./company-stop-guard"
import { runFlowNode } from "./flow"

export interface SendFlowDirectParams {
  contactId: string
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

  const outcomes = await Promise.all(
    allContactInboxes.map(
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
