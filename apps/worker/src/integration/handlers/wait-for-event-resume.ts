import {
  type SmartDelayRow,
  smartDelayService,
} from "@chatbotx.io/business/smart-delay"
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

  // The claim RETURNS the row it took (same statement): a failed event resume
  // re-pointed this row at the EVENT edge, and the snapshot above may predate
  // that, so only the returned row's nodeId is the edge to run.
  const claimed = await smartDelayService.claimRunning({ id: row.id })
  if (!claimed) {
    return
  }
  if (!claimed.nodeId) {
    // No timeout edge: the wait simply ends.
    await smartDelayService.finishClaimedRun({
      id: claimed.id,
      generation: claimed.claimGeneration,
    })
    return
  }
  await runClaimedSmartDelay(
    claimed,
    buildSendFlowResumeJob(claimed),
    parentJob,
  )
}

/**
 * A retried event job must never resume a wait CREATED AFTER the event fired:
 * the contact-wide lookup runs fresh on every attempt, so without this a
 * BullMQ retry of an old `tagApplied` would satisfy a brand-new wait for the
 * same tag. Fails closed on a job enqueued before `emittedAt` was carried.
 */
export const eventPrecedesRow = (
  event: Pick<EventPayload, "emittedAt">,
  row: Pick<SmartDelayRow, "createdAt">,
): boolean => {
  if (typeof event.emittedAt !== "string") {
    return false
  }
  const emittedAt = Date.parse(event.emittedAt)
  return Number.isFinite(emittedAt) && row.createdAt.getTime() <= emittedAt
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
    if (
      !(
        spec.success &&
        eventMatchesSpec(spec.data, event) &&
        eventPrecedesRow(event, row)
      )
    ) {
      continue
    }
    const wasScheduled = row.status === smartDelayStatuses.enum.scheduled
    // The claim re-points the row at its event edge (nodeId) and returns it.
    const claimed = await smartDelayService.claimForEvent({ id: row.id })
    if (!claimed) {
      continue // the timeout (or another event) got there first
    }
    if (wasScheduled) {
      // Best effort: a job already running loses the CAS above anyway. The
      // job id was built from the PRE-claim triggerAt (the claim moved it).
      try {
        await integrationQueue.remove(buildJobId(row.id, row.triggerAt))
      } catch (err) {
        logger.warn(
          { err: normalizeError(err), smartDelayId: row.id },
          "Could not remove the timeout job of an event-resumed wait",
        )
      }
    }
    if (!claimed.nodeId) {
      // No event edge: the wait simply ends.
      await smartDelayService.finishClaimedRun({
        id: claimed.id,
        generation: claimed.claimGeneration,
      })
      continue
    }
    await runClaimedSmartDelay(
      claimed,
      buildSendFlowResumeJob(claimed),
      parentJob,
    )
  }
}
