import {
  db,
  isForeignKeyViolationError,
  isUniqueViolationError,
  sql,
} from "@chatbotx.io/database/client"
import { getDispatchContactInboxes } from "./contacts-on-sequences"
import { createDispatch } from "./dispatch-manager"
import { calculateNextValidSendTime } from "./send-time-validator"

/**
 * s235: a STALLED enrolment is active and due but has no dispatch for its
 * next step. Only `advanceEnrollment` creates the next dispatch, and it only
 * runs when a dispatch finishes, so once the dispatch row is gone the chain is
 * broken for good. Ways to get there:
 * - deleting a sequence step (it cascades the step's pending dispatches);
 * - the dispatch's ContactInbox (or Inbox) deleted under it;
 * - no inbox when the step was scheduled;
 * - a crash between a bulk enrol's insert and its dispatches.
 * The reconcile job (worker `ReconcileJob`) re-dispatches them.
 */

/**
 * Due for this long before a re-dispatch: a bulk enrol inserts the enrolment
 * before its dispatch, and an advance writes both in one transaction.
 */
export const STALLED_ENROLLMENT_GRACE_MS = 10 * 60 * 1000

/**
 * Older than this is never re-dispatched. Terminal dispatch rows are deleted
 * after 30 days, after which a FAILED step would look never-dispatched.
 */
export const STALLED_ENROLLMENT_MAX_AGE_MS = 25 * 24 * 60 * 60 * 1000

/** Rows per scan; the caller pages with `afterId`. */
export const STALLED_ENROLLMENT_BATCH = 200

/**
 * The stall predicate, on the enrolment row `cos` (SQL fragment):
 * - active, not paused, and its next step still exists and is active;
 * - no LIVE dispatch;
 * - no dispatch of ANY status for that step in this cycle (a failed or
 *   canceled step is never re-sent; only a vanished or never-made one is).
 */
const stalledPredicate = (now: Date) => {
  const dueBefore = new Date(now.getTime() - STALLED_ENROLLMENT_GRACE_MS)
  const notOlderThan = new Date(now.getTime() - STALLED_ENROLLMENT_MAX_AGE_MS)
  return sql`
    cos."status" = 'active'
    AND cos."completedAt" IS NULL
    AND cos."nextStepId" IS NOT NULL
    AND cos."nextRunAt" IS NOT NULL
    AND cos."nextRunAt" <= ${dueBefore}
    AND cos."nextRunAt" > ${notOlderThan}
    AND (cos."pausedUntil" IS NULL OR cos."pausedUntil" <= ${now})
    AND EXISTS (
      SELECT 1 FROM "SequenceStep" st
       WHERE st."id" = cos."nextStepId" AND st."sequenceId" = cos."sequenceId"
         AND st."isActive" = true
    )
    AND NOT EXISTS (
      SELECT 1 FROM "SequenceDispatch" sd
       WHERE sd."workspaceId" = cos."workspaceId" AND sd."enrollmentId" = cos."id"
         AND sd."status" IN ('pending', 'running', 'held')
    )
    AND NOT EXISTS (
      SELECT 1 FROM "SequenceDispatch" sd
       WHERE sd."workspaceId" = cos."workspaceId" AND sd."enrollmentId" = cos."id"
         AND sd."stepId" = cos."nextStepId"
         AND sd."createdAt" >= cos."enrolledAt"
    )`
}

export type StalledEnrollment = { id: string; workspaceId: string }

/** One page of stalled enrolments, oldest due first is not needed: by id. */
export async function listStalledEnrollments(params: {
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
     WHERE ${stalledPredicate(now)}
       ${params.afterId ? sql`AND cos."id" > ${params.afterId}` : sql``}
     ORDER BY cos."id"
     LIMIT ${limit}`)
  return result.rows as StalledEnrollment[]
}

export type RedispatchResult =
  | {
      kind: "redispatched"
      dispatch: { id: string; bucket: number; runAtMs: string }
    }
  | { kind: "skipped"; reason: "not-stalled" | "no-inbox" | "raced" }

/**
 * Re-dispatch ONE stalled enrolment. The enrolment is locked first (every
 * enrolment writer's order) and the whole predicate is re-checked under the
 * lock, so a concurrent advance, end, hold or another reconcile fails closed.
 * One dispatch, on the contact's most recently active inbox (owner rule: one
 * flow run per step), at the first valid send time from now. The caller
 * schedules the returned dispatch after the commit.
 */
export async function redispatchStalledEnrollment(params: {
  workspaceId: string
  enrollmentId: string
  now?: Date
}): Promise<RedispatchResult> {
  const now = params.now ?? new Date()
  const { workspaceId, enrollmentId } = params
  try {
    return await db.transaction(async (tx) => {
      const locked = await tx.execute(sql`
        SELECT cos."id"::text AS id, cos."contactId"::text AS "contactId",
               cos."sequenceId"::text AS "sequenceId",
               cos."nextStepId"::text AS "nextStepId"
          FROM "ContactOnSequence" cos
         WHERE cos."id" = ${enrollmentId} AND cos."workspaceId" = ${workspaceId}
           FOR UPDATE`)
      if (locked.rows.length === 0) {
        return { kind: "skipped", reason: "not-stalled" } as const
      }
      const still = await tx.execute(sql`
        SELECT 1 FROM "ContactOnSequence" cos
         WHERE cos."id" = ${enrollmentId} AND cos."workspaceId" = ${workspaceId}
           AND ${stalledPredicate(now)}`)
      if (still.rows.length === 0) {
        return { kind: "skipped", reason: "not-stalled" } as const
      }
      const row = locked.rows[0] as {
        contactId: string
        sequenceId: string
        nextStepId: string
      }
      const [inbox] = await getDispatchContactInboxes(
        workspaceId,
        row.contactId,
      )
      if (!inbox) {
        return { kind: "skipped", reason: "no-inbox" } as const
      }
      const step = await tx.query.sequenceStepModel.findFirst({
        where: { id: row.nextStepId },
      })
      if (!step) {
        return { kind: "skipped", reason: "not-stalled" } as const
      }
      const runAt = calculateNextValidSendTime(now, step)
      await tx.execute(sql`
        UPDATE "ContactOnSequence" SET "nextRunAt" = ${runAt}, "updatedAt" = now()
         WHERE "id" = ${enrollmentId} AND "workspaceId" = ${workspaceId}`)
      const dispatch = await createDispatch({
        client: tx,
        workspaceId,
        sequenceId: row.sequenceId,
        contactId: row.contactId,
        contactInboxId: inbox.id,
        stepId: row.nextStepId,
        enrollmentId,
        runAt,
      })
      return { kind: "redispatched", dispatch } as const
    })
  } catch (error) {
    // Another writer made this exact dispatch, or the enrolment went away.
    if (
      isUniqueViolationError(error, "SequenceDispatch_idempotencyKey_key") ||
      isForeignKeyViolationError(
        error,
        "SequenceDispatch_enrollment_workspace_fkey",
      )
    ) {
      return { kind: "skipped", reason: "raced" }
    }
    throw error
  }
}
