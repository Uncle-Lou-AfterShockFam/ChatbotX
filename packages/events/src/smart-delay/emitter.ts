import {
  type TriggerEventType,
  triggerEventTypes,
} from "@chatbotx.io/database/partials"
import { enqueueIntegrationJob } from "@chatbotx.io/worker-config"
import { BaseEventEmitter } from "../base-emitter"

/**
 * Wakes parked `waitForEvent` flow runs (a tag, a custom field, or a form). Unlike the trigger emitter this has
 * NO context filter: a tag applied by a flow step inside the worker is exactly
 * the signal a waiting run needs, and no trigger has to exist for it. The
 * worker does the lookup, so this is one cheap enqueue per event.
 */
const WAIT_FOR_EVENT_TYPES = new Set<TriggerEventType>([
  triggerEventTypes.enum.tagApplied,
  triggerEventTypes.enum.customFieldValueChanged,
  // s220 A2-3: a wait on ONE form (metadata.formId)
  triggerEventTypes.enum.formSubmitted,
  triggerEventTypes.enum.formAbandoned,
])

type WaitEvent =
  | { eventType: "tagApplied"; tagId: string }
  | {
      eventType: "customFieldChanged"
      customFieldId: string
      newValue: string | null
    }
  | { eventType: "formSubmitted" | "formAbandoned"; formId: string }

/** The job's event half; null when the metadata lacks the id it keys on. */
const waitEventOf = (
  eventType: TriggerEventType,
  metadata: Record<string, unknown>,
): WaitEvent | null => {
  const idOf = (value: unknown) =>
    typeof value === "string" && value !== "" ? value : null
  switch (eventType) {
    case triggerEventTypes.enum.tagApplied: {
      const tagId = idOf(metadata.tagId)
      return tagId ? { eventType: "tagApplied", tagId } : null
    }
    case triggerEventTypes.enum.customFieldValueChanged: {
      const customFieldId = idOf(metadata.customFieldId)
      return customFieldId
        ? {
            eventType: "customFieldChanged",
            customFieldId,
            newValue: newValueOf(metadata.newValue),
          }
        : null
    }
    case triggerEventTypes.enum.formSubmitted:
    case triggerEventTypes.enum.formAbandoned: {
      const formId = idOf(metadata.formId)
      return formId ? { eventType, formId } : null
    }
    default:
      return null
  }
}

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
    const event = waitEventOf(eventType, metadata)
    if (!event) {
      return
    }
    // A form event carries WHEN it happened: a delayed emit (tags / field
    // events awaited first, the abandon catch-up) must not resume a wait
    // parked after the fact (Codex probe, s220 A2-3).
    const occurredAt =
      typeof metadata.occurredAt === "string" &&
      Number.isFinite(Date.parse(metadata.occurredAt))
        ? new Date(metadata.occurredAt).toISOString()
        : null
    await enqueueIntegrationJob(
      {
        type: "resumeWaitForEvent",
        data: {
          reason: "event",
          workspaceId: data.workspaceId,
          contactId: data.contactId,
          emittedAt: occurredAt ?? new Date().toISOString(),
          ...event,
        },
      },
      { removeOnComplete: true, removeOnFail: 100 },
    )
  }
}

export const SmartDelayEventEmitter = new SmartDelayEventEmitterImpl()
