import {
  type TriggerEventType,
  triggerEventTypes,
} from "@chatbotx.io/database/partials"
import { enqueueIntegrationJob } from "@chatbotx.io/worker-config"
import { BaseEventEmitter } from "../base-emitter"

/**
 * Wakes parked `waitForEvent` flow runs. Unlike the trigger emitter this has
 * NO context filter: a tag applied by a flow step inside the worker is exactly
 * the signal a waiting run needs, and no trigger has to exist for it. The
 * worker does the lookup, so this is one cheap enqueue per event.
 */
const WAIT_FOR_EVENT_TYPES = new Set<TriggerEventType>([
  triggerEventTypes.enum.tagApplied,
  triggerEventTypes.enum.customFieldValueChanged,
])

/** A wait can match on the value a field changed TO; anything but text is carried as text, a clear as null. */
const newValueOf = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null
  }
  return typeof value === "string" ? value : JSON.stringify(value)
}

class SmartDelayEventEmitterImpl extends BaseEventEmitter {
  protected supportedEventTypes = WAIT_FOR_EVENT_TYPES

  protected shouldEmitEvent(): Promise<boolean> {
    return Promise.resolve(true)
  }

  protected async emitToQueue(
    eventType: TriggerEventType,
    data: {
      workspaceId: string
      contactId: string
      metadata?: Record<string, unknown>
    },
  ): Promise<void> {
    const metadata = data.metadata ?? {}
    const isTag = eventType === triggerEventTypes.enum.tagApplied
    const id = isTag ? metadata.tagId : metadata.customFieldId
    if (typeof id !== "string" || id === "") {
      return
    }
    await enqueueIntegrationJob(
      {
        type: "resumeWaitForEvent",
        data: {
          reason: "event",
          workspaceId: data.workspaceId,
          contactId: data.contactId,
          emittedAt: new Date().toISOString(),
          ...(isTag
            ? { eventType: "tagApplied", tagId: id }
            : {
                eventType: "customFieldChanged",
                customFieldId: id,
                newValue: newValueOf(metadata.newValue),
              }),
        },
      },
      { removeOnComplete: true, removeOnFail: 100 },
    )
  }
}

export const SmartDelayEventEmitter = new SmartDelayEventEmitterImpl()
