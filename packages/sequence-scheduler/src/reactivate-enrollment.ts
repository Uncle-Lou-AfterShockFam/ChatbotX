import {
  and,
  asc,
  db,
  eq,
  gte,
  inArray,
  sql,
  type Transaction,
} from "@chatbotx.io/database/client"
import {
  contactsOnSequenceModel,
  sequenceDispatchModel,
  sequenceStepModel,
} from "@chatbotx.io/database/schema"
import { calculateNextRunAtFromStep } from "./calculate-next-run-at"
import { getDispatchContactInboxes } from "./contacts-on-sequences"
import { createDispatch } from "./dispatch-manager"
import {
  LIVE_DISPATCH_STATUSES,
  TERMINAL_END_REASONS,
} from "./enrollment-constants"
import { calculateNextValidSendTime } from "./send-time-validator"

type DrizzleClient = typeof db | Transaction
type DispatchToSchedule = { id: string; bucket: number; runAtMs: string }

/** A step's id, order, delay and send window: what scheduling it needs. */
export const stepScheduleColumns = () => ({
  id: sequenceStepModel.id,
  order: sequenceStepModel.order,
  anytime: sequenceStepModel.anytime,
  sendTimeStart: sequenceStepModel.sendTimeStart,
  sendTimeEnd: sequenceStepModel.sendTimeEnd,
  sendDays: sequenceStepModel.sendDays,
  delayDays: sequenceStepModel.delayDays,
  delayMinutes: sequenceStepModel.delayMinutes,
  delayUnit: sequenceStepModel.delayUnit,
  specificDateTime: sequenceStepModel.specificDateTime,
})

export type ReactivateEnrollmentResult =
  | { kind: "notFound" }
  | { kind: "notEnded"; status: string | null }
  | { kind: "terminal"; endReason: string }
  | { kind: "changed" }
  | {
      kind: "reactivated"
      runAt: Date | null
      dispatches: DispatchToSchedule[]
    }

/**
 * Reactivates an ENDED enrolment (s228b, the ManyReach rule). Locks the
 * enrolment first, then its dispatches (every enrolment writer's order); the
 * caller schedules the returned dispatches after its transaction commits.
 *
 * - A step still RUNNING (claimed before the end; the send gate, which locks
 *   the enrolment too, has not seen the end yet): the end is simply undone
 *   and that step goes on - no second dispatch, so it is never sent twice.
 * - Otherwise it resumes at the first active step at or after `currentStep`
 *   that this cycle has not completed, no earlier than now, its old run time,
 *   the pause end, and the last completed send plus the step's delay; moved
 *   into the step's send window.
 * - No such step left (the contact had finished): a restart from the first
 *   step, a new cycle (`enrolledAt` = the DB clock, which dispatch
 *   `createdAt` also uses).
 *
 * The dispatch the end canceled for the step is revived (its idempotency key
 * is creation-time only: just the unique index reads it); otherwise one is
 * created. `expectedUpdatedAt` is the optimistic check of an operator's
 * reactivate.
 */
export async function reactivateEnrollment(params: {
  client?: DrizzleClient
  workspaceId: string
  enrollmentId: string
  expectedUpdatedAt?: Date
  now?: Date
}): Promise<ReactivateEnrollmentResult> {
  const { workspaceId, enrollmentId, expectedUpdatedAt } = params
  const now = params.now ?? new Date()
  const run = async (
    tx: DrizzleClient,
  ): Promise<ReactivateEnrollmentResult> => {
    const [row] = await tx
      .select({
        id: contactsOnSequenceModel.id,
        contactId: contactsOnSequenceModel.contactId,
        sequenceId: contactsOnSequenceModel.sequenceId,
        status: contactsOnSequenceModel.status,
        endReason: contactsOnSequenceModel.endReason,
        currentStep: contactsOnSequenceModel.currentStep,
        enrolledAt: contactsOnSequenceModel.enrolledAt,
        nextRunAt: contactsOnSequenceModel.nextRunAt,
        pausedUntil: contactsOnSequenceModel.pausedUntil,
        updatedAt: contactsOnSequenceModel.updatedAt,
      })
      .from(contactsOnSequenceModel)
      .where(
        and(
          eq(contactsOnSequenceModel.workspaceId, workspaceId),
          eq(contactsOnSequenceModel.id, enrollmentId),
        ),
      )
      .for("no key update")
    if (!row) {
      return { kind: "notFound" }
    }
    if (row.status !== "ended") {
      return { kind: "notEnded", status: row.status }
    }
    if (row.endReason && TERMINAL_END_REASONS.has(row.endReason)) {
      return { kind: "terminal", endReason: row.endReason }
    }
    if (
      expectedUpdatedAt &&
      row.updatedAt.getTime() !== expectedUpdatedAt.getTime()
    ) {
      return { kind: "changed" }
    }
    const reopen = {
      status: "active",
      endedAt: null,
      endReason: null,
      lastError: null,
      updatedAt: new Date(),
    }
    const thisRow = and(
      eq(contactsOnSequenceModel.workspaceId, workspaceId),
      eq(contactsOnSequenceModel.id, enrollmentId),
    )

    const [sending] = await tx
      .select({ id: sequenceDispatchModel.id })
      .from(sequenceDispatchModel)
      .where(
        and(
          eq(sequenceDispatchModel.workspaceId, workspaceId),
          eq(sequenceDispatchModel.enrollmentId, enrollmentId),
          eq(sequenceDispatchModel.status, "running"),
        ),
      )
      .limit(1)
      .for("update")
    if (sending) {
      await tx.update(contactsOnSequenceModel).set(reopen).where(thisRow)
      return { kind: "reactivated", runAt: null, dispatches: [] }
    }

    const [resumeStep] = await tx
      .select(stepScheduleColumns())
      .from(sequenceStepModel)
      .where(
        and(
          eq(sequenceStepModel.sequenceId, row.sequenceId),
          eq(sequenceStepModel.isActive, true),
          gte(sequenceStepModel.order, row.currentStep),
          sql`NOT EXISTS (SELECT 1 FROM ${sequenceDispatchModel} WHERE ${sequenceDispatchModel.workspaceId} = ${workspaceId} AND ${sequenceDispatchModel.enrollmentId} = ${enrollmentId} AND ${sequenceDispatchModel.stepId} = ${sequenceStepModel.id} AND ${sequenceDispatchModel.status} = 'completed' AND ${sequenceDispatchModel.createdAt} >= ${row.enrolledAt})`,
        ),
      )
      .orderBy(asc(sequenceStepModel.order))
      .limit(1)

    let step = resumeStep
    let runAt: Date | null = null
    let restart = false
    if (step) {
      const [last] = await tx
        .select({
          completedAt: sql<
            string | null
          >`max(${sequenceDispatchModel.completedAt})`,
        })
        .from(sequenceDispatchModel)
        .where(
          and(
            eq(sequenceDispatchModel.workspaceId, workspaceId),
            eq(sequenceDispatchModel.enrollmentId, enrollmentId),
            eq(sequenceDispatchModel.status, "completed"),
            gte(sequenceDispatchModel.createdAt, row.enrolledAt),
          ),
        )
      const afterLastSend = last?.completedAt
        ? calculateNextRunAtFromStep(step, new Date(last.completedAt))
        : null
      const floor = [
        row.nextRunAt,
        row.pausedUntil,
        afterLastSend,
      ].reduce<Date>(
        (latest, value) => (value && value > latest ? value : latest),
        now,
      )
      runAt = calculateNextValidSendTime(floor, step)
    } else {
      restart = true
      const [first] = await tx
        .select(stepScheduleColumns())
        .from(sequenceStepModel)
        .where(
          and(
            eq(sequenceStepModel.sequenceId, row.sequenceId),
            eq(sequenceStepModel.isActive, true),
          ),
        )
        .orderBy(asc(sequenceStepModel.order))
        .limit(1)
      step = first
      if (first) {
        runAt = calculateNextValidSendTime(
          calculateNextRunAtFromStep(first, now),
          first,
        )
      }
    }

    await tx
      .update(contactsOnSequenceModel)
      .set({
        ...reopen,
        completedAt: null,
        currentStep: step ? step.order : row.currentStep,
        nextStepId: step?.id ?? null,
        nextRunAt: runAt,
        ...(restart ? { enrolledAt: sql`now()`, lastStepId: null } : {}),
      })
      .where(thisRow)

    if (!(step && runAt)) {
      return { kind: "reactivated", runAt: null, dispatches: [] }
    }
    const [inbox] = await getDispatchContactInboxes(workspaceId, row.contactId)
    if (!inbox) {
      return { kind: "reactivated", runAt, dispatches: [] }
    }
    // Never a second live dispatch (a concurrent writer may have made one).
    const [live] = await tx
      .select({ id: sequenceDispatchModel.id })
      .from(sequenceDispatchModel)
      .where(
        and(
          eq(sequenceDispatchModel.workspaceId, workspaceId),
          eq(sequenceDispatchModel.enrollmentId, enrollmentId),
          inArray(sequenceDispatchModel.status, [...LIVE_DISPATCH_STATUSES]),
        ),
      )
      .limit(1)
    if (live) {
      return { kind: "reactivated", runAt, dispatches: [] }
    }
    const [revived] = await tx
      .update(sequenceDispatchModel)
      .set({
        status: "pending",
        runAtMs: String(runAt.getTime()),
        contactInboxId: inbox.id,
        lastError: null,
        lockedAt: null,
        lockOwner: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sequenceDispatchModel.workspaceId, workspaceId),
          eq(sequenceDispatchModel.enrollmentId, enrollmentId),
          eq(sequenceDispatchModel.stepId, step.id),
          eq(sequenceDispatchModel.status, "canceled"),
          sql`${sequenceDispatchModel.id} = (SELECT ${sequenceDispatchModel.id} FROM ${sequenceDispatchModel} WHERE ${sequenceDispatchModel.workspaceId} = ${workspaceId} AND ${sequenceDispatchModel.enrollmentId} = ${enrollmentId} AND ${sequenceDispatchModel.stepId} = ${step.id} AND ${sequenceDispatchModel.status} = 'canceled' ORDER BY ${sequenceDispatchModel.id} DESC LIMIT 1)`,
        ),
      )
      .returning({
        id: sequenceDispatchModel.id,
        bucket: sequenceDispatchModel.bucket,
        runAtMs: sequenceDispatchModel.runAtMs,
      })
    if (revived) {
      return { kind: "reactivated", runAt, dispatches: [revived] }
    }
    const created = await createDispatch({
      client: tx,
      workspaceId,
      sequenceId: row.sequenceId,
      contactId: row.contactId,
      contactInboxId: inbox.id,
      stepId: step.id,
      enrollmentId,
      runAt,
    })
    return { kind: "reactivated", runAt, dispatches: [created] }
  }
  return params.client ? await run(params.client) : await db.transaction(run)
}
