import {
  type SmartDelayRow,
  smartDelayService,
} from "@chatbotx.io/business/smart-delay"
import {
  type SmartDelayType,
  smartDelayStatuses,
  smartDelayTypes,
} from "@chatbotx.io/database/partials"
import {
  buildJobId,
  ENQUEUE_DELAY_MS,
  type MetadataPayload,
  metadataSchema,
  type WaitForEventSpec,
} from "@chatbotx.io/flow-config"
import { createId } from "@chatbotx.io/utils"
import {
  IntegrationJobAction,
  type IntegrationJobData,
  integrationQueue,
} from "@chatbotx.io/worker-config"
import { logger } from "../../lib/logger"

type SmartDelayJobSpec = {
  name: IntegrationJobData["type"]
  data: IntegrationJobData
}

type SmartDelayResumeJobExtras = {
  metadata?: MetadataPayload
  sendFrom?: "inbox"
  appointmentId?: string
}

const parseResumeMetadata = (
  value: Record<string, unknown> | null,
): MetadataPayload | undefined => {
  if (!value) {
    return
  }

  const parsed = metadataSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export const buildSendFlowResumeJob = (
  row: SmartDelayRow,
  extras?: SmartDelayResumeJobExtras,
): SmartDelayJobSpec => {
  const metadata = extras?.metadata ?? parseResumeMetadata(row.metadata)
  const appointmentId = extras?.appointmentId ?? row.appointmentId ?? undefined

  return {
    name: IntegrationJobAction.sendFlow,
    data: {
      type: IntegrationJobAction.sendFlow,
      data: {
        conversationId: row.conversationId,
        contactInboxId: row.contactInboxId,
        flowId: row.flowId,
        flowVersionId: row.flowVersionId ?? undefined,
        nodeId: row.nodeId ?? undefined,
        ...(metadata ? { metadata } : {}),
        ...(extras?.sendFrom ? { sendFrom: extras.sendFrom } : {}),
        ...(appointmentId ? { appointmentId } : {}),
      },
    },
  }
}

const buildResumeFollowUpJob = (row: SmartDelayRow): SmartDelayJobSpec => ({
  name: IntegrationJobAction.resumeFollowUp,
  data: {
    type: IntegrationJobAction.resumeFollowUp,
    data: { smartDelayId: row.id },
  },
})

const buildResumeWaitForEventJob = (row: SmartDelayRow): SmartDelayJobSpec => ({
  name: IntegrationJobAction.resumeWaitForEvent,
  data: {
    type: IntegrationJobAction.resumeWaitForEvent,
    data: { reason: "timeout", smartDelayId: row.id },
  },
})

const buildResumeWaitJob = (row: SmartDelayRow): SmartDelayJobSpec => ({
  name: IntegrationJobAction.resumeWait,
  data: {
    type: IntegrationJobAction.resumeWait,
    data: { smartDelayId: row.id },
  },
})

export const smartDelayResumeJobFactories: Record<
  SmartDelayType,
  (row: SmartDelayRow, extras?: SmartDelayResumeJobExtras) => SmartDelayJobSpec
> = {
  [smartDelayTypes.enum.waitNode]: buildResumeWaitJob,
  [smartDelayTypes.enum.followUp]: buildResumeFollowUpJob,
  [smartDelayTypes.enum.waitForEvent]: buildResumeWaitForEventJob,
}

const smartDelayPersistenceHandlers: Record<
  SmartDelayType,
  (row: SmartDelayRow) => Promise<SmartDelayRow>
> = {
  [smartDelayTypes.enum.waitNode]: async (data) => {
    await smartDelayService.create({ data })
    return data
  },
  [smartDelayTypes.enum.followUp]: async (data) =>
    await smartDelayService.upsertFollowUp({ data }),
  [smartDelayTypes.enum.waitForEvent]: async (data) => {
    await smartDelayService.create({ data })
    return data
  },
}

/**
 * A wait written for a contact whose company is stopped is canceled at once.
 * The step that wrote it may have started before the stop (and passed its
 * claimCheck) while the stop's cancel pass had already run; checking after the
 * write closes that window (see `isContactInboxStopped`). A failed check is
 * logged and the row kept: every resume re-checks before it runs.
 */
async function isStoppedCompanyRow(row: SmartDelayRow): Promise<boolean> {
  try {
    if (
      !(await smartDelayService.isContactInboxStopped({
        workspaceId: row.workspaceId,
        contactInboxId: row.contactInboxId,
      }))
    ) {
      return false
    }
    await smartDelayService.cancelIfNotStarted({ id: row.id })
    logger.info(
      { rowId: row.id, contactInboxId: row.contactInboxId },
      "Smart delay canceled at creation: the contact's company is stopped",
    )
    return true
  } catch (err) {
    logger.warn(
      { err, rowId: row.id },
      "Stopped-company check failed at creation; the resume re-checks",
    )
    return false
  }
}

export async function scheduleSmartDelayResume(props: {
  type: SmartDelayType
  triggerAt: Date
  workspaceId: string
  flowId: string
  flowVersionId: string | null
  conversationId: string
  contactInboxId: string
  /** The node the timer resumes at; null = a waitForEvent whose timeout edge is unconnected (the scanner completes it silently). */
  connectedNodeId: string | null
  stepId: string
  metadata?: MetadataPayload
  sendFrom?: "inbox"
  appointmentId?: string
  /** waitForEvent only. */
  eventNodeId?: string | null
  eventSpec?: WaitForEventSpec | null
}): Promise<void> {
  const rowId = createId()
  const row: SmartDelayRow = {
    id: rowId,
    workspaceId: props.workspaceId,
    flowId: props.flowId,
    flowVersionId: props.flowVersionId,
    contactInboxId: props.contactInboxId,
    appointmentId: props.appointmentId ?? null,
    conversationId: props.conversationId,
    nodeId: props.connectedNodeId,
    stepId: props.stepId,
    metadata: props.metadata ?? null,
    eventNodeId: props.eventNodeId ?? null,
    eventSpec: props.eventSpec ?? null,
    type: props.type,
    createdAt: new Date(),
    triggerAt: props.triggerAt,
    status: smartDelayStatuses.enum.pending,
    claimGeneration: 0,
    claimedAt: null,
  }

  // Insert tracking record first so a crash during enqueue still has a recovery path via scanner.
  const persistedRow = await smartDelayPersistenceHandlers[props.type](row)

  if (await isStoppedCompanyRow(persistedRow)) {
    return
  }

  const diffMs = persistedRow.triggerAt.getTime() - Date.now()
  if (diffMs > ENQUEUE_DELAY_MS) {
    return
  }

  try {
    const marked = await smartDelayService.markScheduled({
      id: persistedRow.id,
      triggerAt: persistedRow.triggerAt,
    })
    if (!marked) {
      // Canceled, claimed (event / scanner) or re-armed since the write: the
      // row's new owner decides, and a canceled row must stay canceled.
      return
    }

    const job = smartDelayResumeJobFactories[persistedRow.type](persistedRow, {
      metadata: props.metadata,
      sendFrom: props.sendFrom,
      appointmentId: props.appointmentId,
    })
    await integrationQueue.add(job.name, job.data, {
      delay: Math.max(0, diffMs),
      jobId: buildJobId(persistedRow.id, persistedRow.triggerAt),
    })
  } catch (err) {
    try {
      await smartDelayService.resetToPending({
        ids: [persistedRow.id],
        triggerAt: persistedRow.triggerAt,
      })
    } catch (resetErr) {
      logger.warn(
        { err: resetErr, rowId: persistedRow.id },
        "Failed to reset immediate smart delay after enqueue failure",
      )
    }
    logger.warn(
      { err, rowId: persistedRow.id },
      "Failed to immediately enqueue smart delay; scanner will pick it up",
    )
  }
}
