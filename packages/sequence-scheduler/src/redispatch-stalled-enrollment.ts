import {
  and,
  db,
  eq,
  isForeignKeyViolationError,
  isUniqueViolationError,
  sql,
} from "@chatbotx.io/database/client"
import {
  contactsOnSequenceModel,
  sequenceStepModel,
} from "@chatbotx.io/database/schema"
import { getDispatchContactInboxes } from "./contacts-on-sequences"
import { createDispatch } from "./dispatch-manager"
import { LIVE_DISPATCH_STATUSES } from "./enrollment-constants"
import { stepScheduleColumns } from "./reactivate-enrollment"
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
 * Two clocks stamp a cycle: `enrolledAt` is often the APP clock (a JS Date)
 * while a dispatch's `createdAt` is the DB clock at its transaction START, so
 * an enrolment's own first dispatch can read a few ms "before" the cycle
 * (s235 probe g). A dispatch this close before `enrolledAt` still counts as
 * this cycle; a real restart is far later than this.
 */
export const CYCLE_CLOCK_TOLERANCE = "5 minutes"

/**
 * The step the enrolment must run next: the first ACTIVE step at or after
 * `currentStep` (the order of the next step to run), like a reactivation.
 * Never `nextStepId` alone: deleting an EARLIER step can leave it pointing
 * one step ahead, and trusting it would skip a step (s235 probe e).
 */
const targetStepId = sql`(
  SELECT st."id" FROM "SequenceStep" st
   WHERE st."sequenceId" = cos."sequenceId" AND st."isActive" = true
     AND st."order" >= cos."currentStep"
   ORDER BY st."order", st."id"
   LIMIT 1)`

const liveStatuses = sql.join(
  LIVE_DISPATCH_STATUSES.map((status) => sql`${status}`),
  sql`, `,
)

/**
 * The stall predicate, on the enrolment row `cos` (SQL fragment):
 * - active, not completed, not paused, due past the grace, not too old;
 * - it has a target step (an active step at or after `currentStep`);
 * - no LIVE dispatch;
 * - no dispatch of ANY status for the target step in this cycle (a failed,
 *   canceled or completed step is never re-sent; only a vanished or
 *   never-made one is).
 */
const stalledPredicate = (now: Date) => {
  const dueBefore = new Date(now.getTime() - STALLED_ENROLLMENT_GRACE_MS)
  const notOlderThan = new Date(now.getTime() - STALLED_ENROLLMENT_MAX_AGE_MS)
  return sql`
    cos."status" = 'active'
    AND cos."completedAt" IS NULL
    AND cos."nextRunAt" IS NOT NULL
    AND cos."nextRunAt" <= ${dueBefore}
    AND cos."nextRunAt" > ${notOlderThan}
    AND (cos."pausedUntil" IS NULL OR cos."pausedUntil" <= ${now})
    AND ${targetStepId} IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "SequenceDispatch" sd
       WHERE sd."workspaceId" = cos."workspaceId" AND sd."enrollmentId" = cos."id"
         AND sd."status" IN (${liveStatuses})
    )
    AND NOT EXISTS (
      SELECT 1 FROM "SequenceDispatch" sd
       WHERE sd."workspaceId" = cos."workspaceId" AND sd."enrollmentId" = cos."id"
         AND sd."stepId" = ${targetStepId}
         AND sd."createdAt" >= cos."enrolledAt" - ${CYCLE_CLOCK_TOLERANCE}::interval
    )`
}

/** The enrolment's `lastError` while no inbox can carry its next step. */
export const NO_INBOX_ERROR =
  "Stalled: the contact has no inbox to send the next sequence step on"

/** Inserting the dispatch lost to a delete or a twin: a race, not a fault. */
const RACE_CONSTRAINTS = {
  unique: ["SequenceDispatch_idempotencyKey_key"],
  foreignKey: [
    "SequenceDispatch_enrollment_workspace_fkey",
    "SequenceDispatch_stepId_SequenceStep_id_fkey",
    "SequenceDispatch_contactInboxId_ContactInbox_id_fkey",
  ],
} as const

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
      // The enrolment first: every enrolment writer's lock order.
      const [row] = await tx
        .select({
          contactId: contactsOnSequenceModel.contactId,
          sequenceId: contactsOnSequenceModel.sequenceId,
        })
        .from(contactsOnSequenceModel)
        .where(
          and(
            eq(contactsOnSequenceModel.workspaceId, workspaceId),
            eq(contactsOnSequenceModel.id, enrollmentId),
          ),
        )
        .for("update")
      if (!row) {
        return { kind: "skipped", reason: "not-stalled" } as const
      }
      const still = await tx.execute<{ targetStepId: string }>(sql`
        SELECT ${targetStepId}::text AS "targetStepId"
          FROM "ContactOnSequence" cos
         WHERE cos."id" = ${enrollmentId} AND cos."workspaceId" = ${workspaceId}
           AND ${stalledPredicate(now)}`)
      const stepId = still.rows[0]?.targetStepId
      if (!stepId) {
        return { kind: "skipped", reason: "not-stalled" } as const
      }
      const [inbox] = await getDispatchContactInboxes(
        workspaceId,
        row.contactId,
      )
      if (!inbox) {
        // Say so on the enrolment: it stays listed, but past the max age it
        // is never looked at again, and the operator must see why (s235).
        await tx
          .update(contactsOnSequenceModel)
          .set({ lastError: NO_INBOX_ERROR, updatedAt: new Date() })
          .where(
            and(
              eq(contactsOnSequenceModel.workspaceId, workspaceId),
              eq(contactsOnSequenceModel.id, enrollmentId),
              // Written once, not on every hourly pass.
              sql`${contactsOnSequenceModel.lastError} IS DISTINCT FROM ${NO_INBOX_ERROR}`,
            ),
          )
        return { kind: "skipped", reason: "no-inbox" } as const
      }
      const [step] = await tx
        .select(stepScheduleColumns())
        .from(sequenceStepModel)
        .where(eq(sequenceStepModel.id, stepId))
        .limit(1)
      if (!step) {
        return { kind: "skipped", reason: "not-stalled" } as const
      }
      const runAt = calculateNextValidSendTime(now, step)
      await tx
        .update(contactsOnSequenceModel)
        .set({
          currentStep: step.order,
          nextStepId: step.id,
          nextRunAt: runAt,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(contactsOnSequenceModel.workspaceId, workspaceId),
            eq(contactsOnSequenceModel.id, enrollmentId),
          ),
        )
      const dispatch = await createDispatch({
        client: tx,
        workspaceId,
        sequenceId: row.sequenceId,
        contactId: row.contactId,
        contactInboxId: inbox.id,
        stepId: step.id,
        enrollmentId,
        runAt,
      })
      return { kind: "redispatched", dispatch } as const
    })
  } catch (error) {
    // Another writer made this exact dispatch, or the enrolment went away.
    if (
      RACE_CONSTRAINTS.unique.some((name) =>
        isUniqueViolationError(error, name),
      ) ||
      RACE_CONSTRAINTS.foreignKey.some((name) =>
        isForeignKeyViolationError(error, name),
      )
    ) {
      return { kind: "skipped", reason: "raced" }
    }
    throw error
  }
}
