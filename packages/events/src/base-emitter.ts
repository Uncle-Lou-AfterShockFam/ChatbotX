import {
  type ContactInfoType,
  type TriggerEventType,
  triggerEventTypes,
} from "@chatbotx.io/database/partials"
import { withContactInboxMetadata } from "./contact-inbox-context"

/** Channel-neutral voice-call event metadata carried to triggers/webhooks. */
export type CallEventMetadata = { callId: string }
export type IncomingCallMetadata = CallEventMetadata & {
  conversationId?: string
}
export type CallEndedMetadata = CallEventMetadata & {
  durationSeconds?: number
}
export type CallRecordedMetadata = CallEventMetadata & {
  recordingUrl?: string
}
export type CallTranscribedMetadata = CallEventMetadata & {
  transcript?: string
}

/**
 * Deal (pipeline "ticket") event metadata carried to triggers/webhooks. The
 * `ticket*` trigger types predate the deal tables; the events keep those names.
 * Trigger conditions match on `sourceId` EXACTLY, so every deal event sets it:
 * the pipeline id for created/value/status/priority, the DESTINATION stage id
 * for a stage move (the pipeline and origin stage ride along in the metadata).
 */
export type DealEventMetadata = {
  dealId: string
  pipelineId: string
  stageId: string
  title: string
  value: string | null
  currency: string
  status: string
  priority: string
  ownerId?: string | null
  companyId?: string | null
}
export type DealMovedToStageMetadata = DealEventMetadata & {
  fromStageId: string
}
export type DealValueChangedMetadata = DealEventMetadata & {
  oldValue: string | null
}
export type DealStatusChangedMetadata = DealEventMetadata & {
  oldStatus: string
}
export type DealPriorityChangedMetadata = DealEventMetadata & {
  oldPriority: string
}
/**
 * Task events ride on the deal metadata (the trigger is pinned to the
 * pipeline, `sourceId = pipelineId`) plus the task itself.
 */
export type DealTaskEventMetadata = DealEventMetadata & {
  taskId: string
  taskTitle: string
  taskDueAt: string | null
  assigneeId: string | null
  templateId: string | null
}
export type DealTaskCompletedMetadata = DealTaskEventMetadata & {
  completedById: string | null
}
export type DealTaskAssignedMetadata = DealTaskEventMetadata & {
  previousAssigneeId: string | null
}

/**
 * Base event emitter class with common functionality
 */
export abstract class BaseEventEmitter {
  protected abstract supportedEventTypes: ReadonlySet<TriggerEventType>
  protected abstract shouldEmitEvent(
    eventType: TriggerEventType,
    workspaceId: string,
    sourceId?: string,
  ): Promise<boolean>

  protected abstract emitToQueue(
    eventType: TriggerEventType,
    data: {
      workspaceId: string
      contactId: string
      metadata?: Record<string, unknown>
    },
  ): Promise<void>

  async emit(
    eventType: TriggerEventType,
    data: {
      workspaceId: string
      contactId: string
      metadata?: Record<string, unknown>
    },
  ): Promise<void> {
    const { workspaceId, contactId, metadata = {} } = data

    if (!(workspaceId && contactId)) {
      return
    }

    if (!this.supportedEventTypes.has(eventType)) {
      return
    }

    const sourceId = metadata.sourceId as string | undefined
    const shouldEmit = await this.shouldEmitEvent(
      eventType,
      workspaceId,
      sourceId,
    )

    if (!shouldEmit) {
      return
    }

    await this.emitToQueue(eventType, data)
  }

  async tagApplied(
    workspaceId: string,
    contactId: string,
    tagId: string,
    contactInboxId?: string,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.tagApplied, {
      workspaceId,
      contactId,
      metadata: withContactInboxMetadata(
        { sourceId: tagId, tagId },
        contactInboxId,
      ),
    })
  }

  async tagRemoved(
    workspaceId: string,
    contactId: string,
    tagId: string,
    contactInboxId?: string,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.tagRemoved, {
      workspaceId,
      contactId,
      metadata: withContactInboxMetadata(
        { sourceId: tagId, tagId },
        contactInboxId,
      ),
    })
  }

  async customFieldChanged(
    workspaceId: string,
    contactId: string,
    customFieldId: string,
    customFieldName: string,
    oldValue: unknown,
    newValue: unknown,
    contactInboxId?: string,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.customFieldValueChanged, {
      workspaceId,
      contactId,
      metadata: withContactInboxMetadata(
        {
          sourceId: customFieldId,
          customFieldId,
          customFieldName,
          oldValue,
          newValue,
        },
        contactInboxId,
      ),
    })
  }

  async contactInfoUpdated(
    workspaceId: string,
    contactId: string,
    infoType: ContactInfoType,
    oldValue: string | null,
    newValue: string,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.contactInfoUpdated, {
      workspaceId,
      contactId,
      metadata: { sourceId: infoType, infoType, oldValue, newValue },
    })
  }

  async conversationTransferredToHuman(
    workspaceId: string,
    contactId: string,
    conversationId: string,
    transferredBy?: string,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.conversationTransferredToHuman, {
      workspaceId,
      contactId,
      metadata: {
        conversationId,
        transferredBy,
      },
    })
  }

  async conversationTransferredToBot(
    workspaceId: string,
    contactId: string,
    conversationId: string,
    transferredBy?: string,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.conversationTransferredToBot, {
      workspaceId,
      contactId,
      metadata: {
        conversationId,
        transferredBy,
      },
    })
  }

  async contactCreated(
    workspaceId: string,
    contactId: string,
    name?: string,
    phone?: string,
    email?: string,
    contactInboxId?: string,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.newContact, {
      workspaceId,
      contactId,
      metadata: withContactInboxMetadata(
        { name, phone, email },
        contactInboxId,
      ),
    })
  }

  async contactReferredANewContact(
    workspaceId: string,
    contactId: string,
    refName?: string,
    reflinkId?: string,
    contactInboxId?: string,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.contactReferredANewContact, {
      workspaceId,
      contactId,
      metadata: withContactInboxMetadata(
        { refName, reflinkId },
        contactInboxId,
      ),
    })
  }

  async contactReferredExistingContact(
    workspaceId: string,
    contactId: string,
    refName?: string,
    reflinkId?: string,
    contactInboxId?: string,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.contactReferredExistingContact, {
      workspaceId,
      contactId,
      metadata: withContactInboxMetadata(
        { refName, reflinkId },
        contactInboxId,
      ),
    })
  }

  async contactUnsubscribed(
    workspaceId: string,
    contactId: string,
    contactInboxId?: string,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.contactUnsubscribedFormBroadcast, {
      workspaceId,
      contactId,
      metadata: withContactInboxMetadata(undefined, contactInboxId),
    })
  }

  async conversationArchived(
    workspaceId: string,
    contactId: string,
    conversationId: string,
    archivedBy?: string,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.archived, {
      workspaceId,
      contactId,
      metadata: {
        conversationId,
        archivedBy,
      },
    })
  }

  async conversationFollowUp(
    workspaceId: string,
    contactId: string,
    conversationId: string,
    markedBy?: string,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.followUp, {
      workspaceId,
      contactId,
      metadata: {
        conversationId,
        markedBy,
      },
    })
  }

  async conversationAssigned(
    workspaceId: string,
    contactId: string,
    conversationId: string,
    assignedTo: string,
    assignedBy?: string,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.conversationAssigned, {
      workspaceId,
      contactId,
      metadata: {
        conversationId,
        assignedTo,
        assignedBy,
      },
    })
  }

  async conversationUnassigned(
    workspaceId: string,
    contactId: string,
    conversationId: string,
    unassignedBy?: string,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.conversationUnassigned, {
      workspaceId,
      contactId,
      metadata: {
        conversationId,
        unassignedBy,
      },
    })
  }

  // Voice-call events (channel-neutral: `metadata.callId` is the provider's
  // call id — a WhatsApp WACID today). Recording/transcript events also carry
  // the public recording URL / transcript text for webhook consumers.
  async incomingCall(
    workspaceId: string,
    contactId: string,
    metadata: IncomingCallMetadata,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.incomingCall, {
      workspaceId,
      contactId,
      metadata,
    })
  }

  async missedAudioCall(
    workspaceId: string,
    contactId: string,
    metadata: IncomingCallMetadata,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.missedAudioCall, {
      workspaceId,
      contactId,
      metadata,
    })
  }

  async callEnded(
    workspaceId: string,
    contactId: string,
    metadata: CallEndedMetadata,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.callEnded, {
      workspaceId,
      contactId,
      metadata,
    })
  }

  async callRecorded(
    workspaceId: string,
    contactId: string,
    metadata: CallRecordedMetadata,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.callRecorded, {
      workspaceId,
      contactId,
      metadata,
    })
  }

  async callTranscribed(
    workspaceId: string,
    contactId: string,
    metadata: CallTranscribedMetadata,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.callTranscribed, {
      workspaceId,
      contactId,
      metadata,
    })
  }

  async sequenceSubscribed(
    workspaceId: string,
    contactId: string,
    sequenceId: string,
    sequenceName: string,
    contactInboxId?: string,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.subscribedToSequence, {
      workspaceId,
      contactId,
      metadata: withContactInboxMetadata(
        { sourceId: sequenceId, sequenceId, sequenceName },
        contactInboxId,
      ),
    })
  }

  async sequenceUnsubscribed(
    workspaceId: string,
    contactId: string,
    sequenceId: string,
    sequenceName: string,
    contactInboxId?: string,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.unsubscribedFromSequence, {
      workspaceId,
      contactId,
      metadata: withContactInboxMetadata(
        { sourceId: sequenceId, sequenceId, sequenceName },
        contactInboxId,
      ),
    })
  }

  // Deal events. `sourceId` = pipelineId, except a stage move where it is the
  // destination stage id (see DealEventMetadata).
  async dealCreated(
    workspaceId: string,
    contactId: string,
    metadata: DealEventMetadata,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.ticketCreated, {
      workspaceId,
      contactId,
      metadata: { ...metadata, sourceId: metadata.pipelineId },
    })
  }

  async dealMovedToStage(
    workspaceId: string,
    contactId: string,
    metadata: DealMovedToStageMetadata,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.ticketMovedToStage, {
      workspaceId,
      contactId,
      metadata: { ...metadata, sourceId: metadata.stageId },
    })
  }

  async dealValueChanged(
    workspaceId: string,
    contactId: string,
    metadata: DealValueChangedMetadata,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.ticketValueChanged, {
      workspaceId,
      contactId,
      metadata: { ...metadata, sourceId: metadata.pipelineId },
    })
  }

  async dealStatusChanged(
    workspaceId: string,
    contactId: string,
    metadata: DealStatusChangedMetadata,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.ticketStatusChanged, {
      workspaceId,
      contactId,
      metadata: { ...metadata, sourceId: metadata.pipelineId },
    })
  }

  async dealPriorityChanged(
    workspaceId: string,
    contactId: string,
    metadata: DealPriorityChangedMetadata,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.ticketPriorityChanged, {
      workspaceId,
      contactId,
      metadata: { ...metadata, sourceId: metadata.pipelineId },
    })
  }

  // Deal task events (s192). `sourceId` = pipelineId, always.
  async dealTaskCreated(
    workspaceId: string,
    contactId: string,
    metadata: DealTaskEventMetadata,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.taskCreated, {
      workspaceId,
      contactId,
      metadata: { ...metadata, sourceId: metadata.pipelineId },
    })
  }

  async dealTaskCompleted(
    workspaceId: string,
    contactId: string,
    metadata: DealTaskCompletedMetadata,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.taskCompleted, {
      workspaceId,
      contactId,
      metadata: { ...metadata, sourceId: metadata.pipelineId },
    })
  }

  async dealTaskOverdue(
    workspaceId: string,
    contactId: string,
    metadata: DealTaskEventMetadata,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.taskOverdue, {
      workspaceId,
      contactId,
      metadata: { ...metadata, sourceId: metadata.pipelineId },
    })
  }

  async dealTaskAssigned(
    workspaceId: string,
    contactId: string,
    metadata: DealTaskAssignedMetadata,
  ): Promise<void> {
    await this.emit(triggerEventTypes.enum.taskAssigned, {
      workspaceId,
      contactId,
      metadata: { ...metadata, sourceId: metadata.pipelineId },
    })
  }
}
