import { contactInboxService } from "@chatbotx.io/business/contact-inbox"
import {
  type SmartDelayRow,
  smartDelayService,
} from "@chatbotx.io/business/smart-delay"
import {
  smartDelayStatuses,
  smartDelayTypes,
} from "@chatbotx.io/database/partials"
import {
  computeFollowUpTriggerAt,
  type FollowUpStepSchema,
} from "@chatbotx.io/flow-config"
import {
  type IntegrationJobResumeFollowUp,
  integrationQueue,
} from "@chatbotx.io/worker-config"
import { logger } from "../../lib/logger"
import { type ExecuteStepProps, seekConnectedNode } from "./flow-utils"
import {
  buildSendFlowResumeJob,
  scheduleSmartDelayResume,
  wasCompanyStoppedSince,
} from "./smart-delay"

type FollowUpStepResult = {
  status: "skip" | "wait"
  result: null
}

// Known gap: like `handleWait` in step.ts, `commentAnchor` is not threaded
// into `scheduleSmartDelayResume` — a comment-triggered public/private-reply
// flow with a followUp step before its first message step loses the anchor
// across the delay. Fixing this needs a `ContactOnSmartDelay` schema change;
// out of scope for now.
export async function handleFollowUp({
  conversation,
  flowVersion,
  contactInbox,
  targetId,
  step,
  useLatestFlowVersion,
  metadata,
  sendFrom,
  runStartedAt,
}: ExecuteStepProps<FollowUpStepSchema>): Promise<FollowUpStepResult> {
  if (!(targetId && step)) {
    return { status: "skip", result: null }
  }

  if (!contactInbox) {
    return { status: "skip", result: null }
  }

  const connectedNodeId = seekConnectedNode(flowVersion, targetId)
  if (!connectedNodeId) {
    return { status: "skip", result: null }
  }

  await scheduleSmartDelayResume({
    runStartedAt,
    type: smartDelayTypes.enum.followUp,
    triggerAt: computeFollowUpTriggerAt(step),
    workspaceId: conversation.workspaceId,
    flowId: flowVersion.flowId,
    flowVersionId: useLatestFlowVersion ? null : flowVersion.id,
    conversationId: conversation.id,
    contactInboxId: contactInbox.id,
    connectedNodeId,
    stepId: step.id,
    metadata,
    sendFrom,
  })

  return { status: "wait", result: null }
}

/**
 * The contact's company was stopped after this follow-up was armed. A failed
 * check is logged and treated as "not stopped": the follow-up path has no
 * claim budget, so a throw here would re-run the row every sweep forever.
 */
async function stoppedSinceArmed(row: SmartDelayRow): Promise<boolean> {
  try {
    return await wasCompanyStoppedSince(row, row.createdAt)
  } catch (err) {
    logger.warn(
      { err, smartDelayId: row.id },
      "Stopped-company check failed on a follow-up resume; continuing",
    )
    return false
  }
}

export async function runFollowUpResume(
  data: IntegrationJobResumeFollowUp["data"],
): Promise<void> {
  const row = await smartDelayService.findById({ id: data.smartDelayId })
  if (
    !row ||
    row.type !== smartDelayTypes.enum.followUp ||
    row.status !== smartDelayStatuses.enum.scheduled ||
    !row.nodeId
  ) {
    return
  }

  if (row.triggerAt.getTime() > Date.now()) {
    return
  }

  const hasReplied = await contactInboxService.hasIncomingMessageSince({
    workspaceId: row.workspaceId,
    contactInboxId: row.contactInboxId,
    since: row.createdAt,
  })

  if (hasReplied) {
    const canceled = await smartDelayService.claimForRun({
      id: row.id,
      triggerAt: row.triggerAt,
      to: smartDelayStatuses.enum.canceled,
    })
    if (!canceled) {
      return
    }
    logger.info(
      { smartDelayId: row.id, conversationId: row.conversationId },
      "Follow-up canceled: contact replied before the timer expired",
    )
    return
  }

  if (await stoppedSinceArmed(row)) {
    await smartDelayService.claimForRun({
      id: row.id,
      triggerAt: row.triggerAt,
      to: smartDelayStatuses.enum.canceled,
    })
    logger.info(
      { smartDelayId: row.id, conversationId: row.conversationId },
      "Follow-up canceled: the contact's company was stopped",
    )
    return
  }

  const completed = await smartDelayService.claimForRun({
    id: row.id,
    triggerAt: row.triggerAt,
    to: smartDelayStatuses.enum.completed,
  })
  if (!completed) {
    return
  }

  // Re-check after the claim: a stop whose stamp committed between the check
  // above and this claim found the row already completed, so its cancel pass
  // skipped it. Reading after our own write sees that stamp.
  if (await stoppedSinceArmed(row)) {
    logger.info(
      { smartDelayId: row.id, conversationId: row.conversationId },
      "Follow-up not continued: the contact's company was stopped",
    )
    return
  }

  const job = buildSendFlowResumeJob(row)
  await integrationQueue.add(job.name, job.data)
}
