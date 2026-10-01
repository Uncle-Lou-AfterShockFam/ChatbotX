import { db, sql } from "@chatbotx.io/database/client"
import type { SchedulerClient } from "@chatbotx.io/scheduler"
import { advanceEnrollment } from "./advance-enrollment"
import { LIVE_DISPATCH_STATUSES } from "./enrollment-constants"
import {
  CYCLE_CLOCK_TOLERANCE,
  STALLED_ENROLLMENT_BATCH,
  STALLED_ENROLLMENT_GRACE_MS,
  STALLED_ENROLLMENT_MAX_AGE_MS,
  type StalledEnrollment,
  targetStepId,
} from "./redispatch-stalled-enrollment"

/**
 * s236: an UNADVANCED enrolment had its step sent and the dispatch marked
 * `completed`, but `advanceEnrollment` never ran: the worker died, or the
 * advance threw, between the two. The send job's retry finds no `running`
 * dispatch, and the s235 stalled pass skips it (a completed dispatch for its
 * step exists this cycle), so nothing would ever queue its next step. The
 * reconcile job (worker `ReconcileJob`) advances it from that dispatch.
 */

// Built per call, never at import (see redispatch-stalled-enrollment.ts).
const liveStatuses = () =>
  sql.join(
    LIVE_DISPATCH_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  )

/**
 * The enrolment's newest dispatch (`cos` in scope). Siblings for one step (one
 * per inbox) share a createdAt: a completed one wins the tie, so a failed
 * sibling never hides the send that must be advanced (probe s236).
 */
const newestDispatch = () => sql`(
  SELECT sd."id" FROM "SequenceDispatch" sd
   WHERE sd."workspaceId" = cos."workspaceId" AND sd."enrollmentId" = cos."id"
   ORDER BY sd."createdAt" DESC, (sd."status" = 'completed') DESC, sd."id" DESC
   LIMIT 1)`

/**
 * The predicate, on the enrolment row `cos` joined to its newest dispatch `nd`:
 * - active and not completed;
 * - no LIVE dispatch (a sibling still sending will advance it itself);
 * - the newest dispatch is COMPLETED, this cycle, past the grace (an advance
 *   may still be on its way) and not too old, and its step is the one the
 *   enrolment stands at (its target step);
 * - the enrolment was not advanced from that step (`lastStepId`).
 */
const unadvancedPredicate = (now: Date) => {
  const completedBefore = new Date(now.getTime() - STALLED_ENROLLMENT_GRACE_MS)
  const notOlderThan = new Date(now.getTime() - STALLED_ENROLLMENT_MAX_AGE_MS)
  return sql`
    cos."status" = 'active'
    AND cos."completedAt" IS NULL
    AND nd."status" = 'completed'
    AND nd."stepId" IS NOT NULL
    AND nd."completedAt" <= ${completedBefore}
    AND nd."completedAt" > ${notOlderThan}
    AND nd."createdAt" >= cos."enrolledAt" - ${CYCLE_CLOCK_TOLERANCE}::interval
    AND nd."stepId" = ${targetStepId()}
    AND cos."lastStepId" IS DISTINCT FROM nd."stepId"
    AND NOT EXISTS (
      SELECT 1 FROM "SequenceDispatch" sd
       WHERE sd."workspaceId" = cos."workspaceId" AND sd."enrollmentId" = cos."id"
         AND sd."status" IN (${liveStatuses()})
    )`
}

/** One page of unadvanced enrolments, by id (the caller pages with `afterId`). */
export async function listUnadvancedEnrollments(params: {
  now?: Date
  afterId?: string
  limit?: number
}): Promise<StalledEnrollment[]> {
  const now = params.now ?? new Date()
  const limit = Math.min(
    Math.max(1, params.limit ?? STALLED_ENROLLMENT_BATCH),
    1000,
  )
  const result = await db.execute(sql`
    SELECT cos."id"::text AS id, cos."workspaceId"::text AS "workspaceId"
      FROM "ContactOnSequence" cos
      JOIN "SequenceDispatch" nd ON nd."id" = ${newestDispatch()}
     WHERE ${unadvancedPredicate(now)}
       ${params.afterId ? sql`AND cos."id" > ${params.afterId}` : sql``}
     ORDER BY cos."id"
     LIMIT ${limit}`)
  return result.rows as StalledEnrollment[]
}

export type RecoverResult =
  | { kind: "advanced" }
  | { kind: "skipped"; reason: "not-unadvanced" }

/**
 * Advance ONE unadvanced enrolment from its newest (completed) dispatch, with
 * `sentAt` = that dispatch's `completedAt`, so the next step keeps its delay.
 * `advanceEnrollment` locks the enrolment and re-checks under the lock (still
 * active, not already advanced from this step, the dispatch's step is still
 * its target, nothing live), so a concurrent job retry or another pass is a
 * no-op. It schedules the next
 * dispatch itself.
 */
export async function recoverUnadvancedEnrollment(params: {
  workspaceId: string
  enrollmentId: string
  scheduler: SchedulerClient
  now?: Date
}): Promise<RecoverResult> {
  const now = params.now ?? new Date()
  const { workspaceId, enrollmentId, scheduler } = params
  const found = await db.execute<{
    dispatchId: string
    stepId: string
    order: number
    completedAt: string | Date
    sequenceId: string
    contactId: string
  }>(sql`
    SELECT nd."id"::text AS "dispatchId", nd."stepId"::text AS "stepId",
           st."order", nd."completedAt",
           cos."sequenceId"::text AS "sequenceId",
           cos."contactId"::text AS "contactId"
      FROM "ContactOnSequence" cos
      JOIN "SequenceDispatch" nd ON nd."id" = ${newestDispatch()}
      JOIN "SequenceStep" st ON st."id" = nd."stepId"
     WHERE cos."id" = ${enrollmentId} AND cos."workspaceId" = ${workspaceId}
       AND ${unadvancedPredicate(now)}`)
  const row = found.rows[0]
  if (!row) {
    return { kind: "skipped", reason: "not-unadvanced" }
  }
  const moved = await advanceEnrollment({
    enrollmentId,
    workspaceId,
    sequenceId: row.sequenceId,
    contactId: row.contactId,
    currentStep: { id: row.stepId, order: Number(row.order) },
    sentAt: new Date(row.completedAt),
    scheduler,
    afterDispatchId: row.dispatchId,
  })
  return moved
    ? { kind: "advanced" }
    : { kind: "skipped", reason: "not-unadvanced" }
}
