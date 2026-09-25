import { smartDelayService } from "@chatbotx.io/business/smart-delay"
import {
  smartDelayStatuses,
  smartDelayTypes,
} from "@chatbotx.io/database/partials"
import {
  buildJobId,
  type WaitForEventSpec,
  waitForEventSpecSchema,
  waitStepEventTypes,
} from "@chatbotx.io/flow-config"
import {
  type IntegrationJobResumeWaitForEvent,
  integrationQueue,
} from "@chatbotx.io/worker-config"
import type { Job } from "bullmq"
import { normalizeError } from "universal-error-normalizer"
import { logger } from "../../lib/logger"
import { buildSendFlowResumeJob } from "./smart-delay"
import { runClaimedSmartDelay } from "./smart-delay-run"

type EventPayload = Extract<
  IntegrationJobResumeWaitForEvent["data"],
  { reason: "event" }
>

/**
 * A `waitForEvent` row wakes up twice at most: once by its timeout job and
 * once per matching tag / custom-field event on the contact. Whichever wins
 * the compare-and-set on the row status resumes the flow on ITS edge; the
 * loser is a silent no-op (the row is already completed).
 */
export async function runWaitForEventResume(
  data: IntegrationJobResumeWaitForEvent["data"],
  parentJob?: Job,
): Promise<void> {
  if (data.reason === "timeout") {
    await resumeOnTimeout(data.smartDelayId, parentJob)
    return
  }
  await resumeOnEvent(data, parentJob)
}

async function resumeOnTimeout(
  smartDelayId: string,
  parentJob?: Job,
): Promise<void> {
  const row = await smartDelayService.findById({ id: smartDelayId })
  if (
    !row ||
    row.type !== smartDelayTypes.enum.waitForEvent ||
    row.status !== smartDelayStatuses.enum.scheduled ||
    row.triggerAt.getTime() > Date.now()
  ) {
    return
  }

  const claimed = await smartDelayService.claimForRun({
    id: row.id,
    to: smartDelayStatuses.enum.completed,
  })
  if (!claimed) {
    return
  }
  // Re-read what we now own: a failed event resume requeues this row pointed
  // at the EVENT edge (requeueClaimedRun), and the snapshot above may predate
  // that, so running its nodeId would take the wrong edge.
  const owned = (await smartDelayService.findById({ id: row.id })) ?? row
  if (!owned.nodeId) {
    // No timeout edge: the wait simply ends.
    return
  }
  await runClaimedSmartDelay(owned.id, buildSendFlowResumeJob(owned), parentJob)
}

/** Does this row wait for the event that just landed? */
export const eventMatchesSpec = (
  spec: WaitForEventSpec,
  event: EventPayload,
): boolean => {
  if (spec.eventType !== event.eventType) {
    return false
  }
  if (spec.eventType === waitStepEventTypes.enum.tagApplied) {
    return Boolean(spec.tagId) && spec.tagId === event.tagId
  }
  if (!spec.customFieldId || spec.customFieldId !== event.customFieldId) {
    return false
  }
  if (spec.matchValue === undefined) {
    return true // any change
  }
  // Value-scoped: fail closed on an empty captured value, a cleared field, or
  // an event enqueued before newValue was carried.
  return (
    spec.matchValue !== "" &&
    typeof event.newValue === "string" &&
    event.newValue.trim() === spec.matchValue
  )
}

async function resumeOnEvent(
  event: EventPayload,
  parentJob?: Job,
): Promise<void> {
  const rows = await smartDelayService.findActiveWaitForEvent({
    workspaceId: event.workspaceId,
    contactId: event.contactId,
  })
  for (const row of rows) {
    const spec = waitForEventSpecSchema.safeParse(row.eventSpec)
    if (!(spec.success && eventMatchesSpec(spec.data, event))) {
      continue
    }
    const wasScheduled = row.status === smartDelayStatuses.enum.scheduled
    const claimed = await smartDelayService.claimForEvent({ id: row.id })
    if (!claimed) {
      continue // the timeout (or another event) got there first
    }
    if (wasScheduled) {
      // Best effort: a job already running loses the CAS above anyway.
      try {
        await integrationQueue.remove(buildJobId(row.id, row.triggerAt))
      } catch (err) {
        logger.warn(
          { err: normalizeError(err), smartDelayId: row.id },
          "Could not remove the timeout job of an event-resumed wait",
        )
      }
    }
    if (!row.eventNodeId) {
      continue // no event edge: the wait simply ends
    }
    await runClaimedSmartDelay(
      row.id,
      buildSendFlowResumeJob({ ...row, nodeId: row.eventNodeId }),
      parentJob,
      { nodeId: row.eventNodeId, triggerAt: new Date() },
    )
  }
}
