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
 * same tag. The instant is the emitter's `emittedAt`; a job enqueued by a
 * pre-deploy emitter has none, so its BullMQ enqueue timestamp (kept across
 * retries) stands in. Neither = no usable instant (null) = fail closed.
 */
export const eventInstant = (
  event: Pick<EventPayload, "emittedAt">,
  parentJob?: Pick<Job, "timestamp">,
): number | null => {
  if (typeof event.emittedAt === "string") {
    const emittedAt = Date.parse(event.emittedAt)
    return Number.isFinite(emittedAt) ? emittedAt : null
  }
  const enqueuedAt = parentJob?.timestamp
  return typeof enqueuedAt === "number" && Number.isFinite(enqueuedAt)
    ? enqueuedAt
    : null
}

export const eventPrecedesRow = (
  instant: number | null,
  row: Pick<SmartDelayRow, "createdAt">,
): boolean => instant !== null && row.createdAt.getTime() <= instant

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
  const instant = eventInstant(event, parentJob)
  // Every matching wait of the contact gets its claim + run in this one job.
  // A row whose edge throws must not starve its siblings (they would sit
  // until their timeout edge although the event fired): run each under its
  // own catch and rethrow the first failure after the loop, so BullMQ still
  // retries the job for the requeued rows.
  let firstFailure: unknown
  for (const row of rows) {
    try {
      await resumeRowOnEvent(row, event, instant, parentJob)
    } catch (err) {
      firstFailure ??= err
    }
  }
  if (firstFailure !== undefined) {
    throw firstFailure
  }
}

async function resumeRowOnEvent(
  row: SmartDelayRow,
  event: EventPayload,
  instant: number | null,
  parentJob?: Job,
): Promise<void> {
  {
    const spec = waitForEventSpecSchema.safeParse(row.eventSpec)
    if (!(spec.success && eventMatchesSpec(spec.data, event))) {
      return
    }
    if (!eventPrecedesRow(instant, row)) {
      // Silent drops hide a cutover gap: say which wait was left to its timeout.
      logger.warn(
        { smartDelayId: row.id, instant, createdAt: row.createdAt },
        "waitForEvent: event predates the wait (or carries no instant); left to its timeout",
      )
      return
    }
    const wasScheduled = row.status === smartDelayStatuses.enum.scheduled
    // The claim re-points the row at its event edge (nodeId) and returns it.
    const claimed = await smartDelayService.claimForEvent({ id: row.id })
    if (!claimed) {
      return // the timeout (or another event) got there first
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
      return
    }
    await runClaimedSmartDelay(
      claimed,
      buildSendFlowResumeJob(claimed),
      parentJob,
    )
  }
}
