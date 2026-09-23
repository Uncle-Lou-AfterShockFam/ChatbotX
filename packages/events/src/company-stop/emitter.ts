import {
  type TriggerEventType,
  triggerEventTypes,
} from "@chatbotx.io/database/partials"
import { enqueueIntegrationJob } from "@chatbotx.io/worker-config"
import { BaseEventEmitter } from "../base-emitter"

/**
 * The company stop rule's tag trigger. Every `tagApplied` becomes one cheap
 * `companyStopOnTag` job; the worker compares the tag's name with the
 * workspace's stop tag and stops the contact's company when they match.
 * Unfiltered like the smart-delay emitter: a tag applied by a flow step
 * inside the worker must count, and no trigger has to exist.
 */
const COMPANY_STOP_EVENT_TYPES = new Set<TriggerEventType>([
  triggerEventTypes.enum.tagApplied,
])

class CompanyStopEventEmitterImpl extends BaseEventEmitter {
  protected supportedEventTypes = COMPANY_STOP_EVENT_TYPES

  protected shouldEmitEvent(): Promise<boolean> {
    return Promise.resolve(true)
  }

  protected async emitToQueue(
    _eventType: TriggerEventType,
    data: {
      workspaceId: string
      contactId: string
      metadata?: Record<string, unknown>
    },
  ): Promise<void> {
    const tagId = data.metadata?.tagId
    if (typeof tagId !== "string" || tagId === "") {
      return
    }
    await enqueueIntegrationJob(
      {
        type: "companyStopOnTag",
        data: {
          workspaceId: data.workspaceId,
          contactId: data.contactId,
          tagId,
        },
      },
      { removeOnComplete: true, removeOnFail: 100 },
    )
  }
}

export const CompanyStopEventEmitter = new CompanyStopEventEmitterImpl()
