import {
  and,
  asc,
  db,
  eq,
  gt,
  inArray,
  isForeignKeyViolationError,
  sql,
} from "@chatbotx.io/database/client"
import {
  contactsOnSequenceModel,
  sequenceDispatchModel,
  sequenceStepModel,
} from "@chatbotx.io/database/schema"
import type { SchedulerClient } from "@chatbotx.io/scheduler"
import { calculateNextRunAtFromStep } from "./calculate-next-run-at"
import { getDispatchContactInboxes } from "./contacts-on-sequences"
import { createDispatch } from "./dispatch-manager"
import { LIVE_DISPATCH_STATUSES } from "./enrollment-constants"
import { calculateNextValidSendTime } from "./send-time-validator"

type NextStepForSchedule = {
  id: string
  order: number
  delayDays: number
  delayMinutes: number
  delayUnit: string | null
  specificDateTime: Date | null
  anytime: boolean
  sendTimeStart: string | null
  sendTimeEnd: string | null
  sendDays: string | null
}

type DispatchToSchedule = { id: string; bucket: number; runAtMs: string }

function calculateNextRunAt(step: NextStepForSchedule, baseTime: Date): Date {
  const calculatedTime = calculateNextRunAtFromStep(
    {
      delayDays: step.delayDays,
      delayMinutes: step.delayMinutes,
      delayUnit: step.delayUnit,
      specificDateTime: step.specificDateTime,
    },
    baseTime,
  )

  return calculateNextValidSendTime(calculatedTime, {
    anytime: step.anytime,
    sendTimeStart: step.sendTimeStart,
    sendTimeEnd: step.sendTimeEnd,
    sendDays: step.sendDays,
  })
}

/**
 * The enrolment row is gone: its contact or workspace was deleted after the
 * dispatch was claimed. (A removal ENDS the row since s228b; it is kept.)
 */
export class EnrollmentNotFoundError extends Error {
  readonly enrollmentId: string

  constructor(enrollmentId: string) {
    super(`Enrollment ${enrollmentId} not found`)
    this.enrollmentId = enrollmentId
    this.name = "EnrollmentNotFoundError"
  }
}

export interface AdvanceEnrollmentParams {
  contactId: string
  currentStep: { id: string; order: number }
  enrollmentId: string
  scheduler: SchedulerClient
  sentAt: Date
  sequenceId: string
  workspaceId: string
}

export async function advanceEnrollment(
  params: AdvanceEnrollmentParams,
): Promise<void> {
  const {
    enrollmentId,
    workspaceId,
    sequenceId,
    contactId,
    currentStep,
    sentAt,
    scheduler,
  } = params

  const enrollment = await db.query.contactsOnSequenceModel.findFirst({
    where: { id: enrollmentId, workspaceId },
  })

  if (!enrollment) {
    throw new EnrollmentNotFoundError(enrollmentId)
  }

  if (enrollment.status !== "active") {
    return
  }

  if (enrollment.lastStepId === currentStep.id) {
    return
  }

  const [nextStep] = await db
    .select()
    .from(sequenceStepModel)
    .where(
      and(
        eq(sequenceStepModel.sequenceId, sequenceId),
        gt(sequenceStepModel.order, currentStep.order),
        eq(sequenceStepModel.isActive, true),
      ),
    )
    .orderBy(asc(sequenceStepModel.order))
    .limit(1)

  const dispatches = await db
    .transaction(async (tx) => {
      // s226b: an out-of-office pause holds the next step. Read under the
      // row lock the pause also takes, so a pause landing now either sees
      // this dispatch (and moves it) or is seen here.
      const [locked] = await tx
        .select({
          status: contactsOnSequenceModel.status,
          pausedUntil: contactsOnSequenceModel.pausedUntil,
        })
        .from(contactsOnSequenceModel)
        .where(
          and(
            eq(contactsOnSequenceModel.id, enrollmentId),
            eq(contactsOnSequenceModel.workspaceId, workspaceId),
          ),
        )
        .for("update")
      // s228b: the row is kept when a removal ends it; one that ended (or
      // was held) after the unlocked read above is never advanced.
      if (locked?.status !== "active") {
        return []
      }
      // s228b (probe): a reactivation already moved it on (it resumed past
      // this step and queued another): never a second live dispatch.
      const [ahead] = await tx
        .select({ id: sequenceDispatchModel.id })
        .from(sequenceDispatchModel)
        .where(
          and(
            eq(sequenceDispatchModel.workspaceId, workspaceId),
            eq(sequenceDispatchModel.enrollmentId, enrollmentId),
            inArray(sequenceDispatchModel.status, [...LIVE_DISPATCH_STATUSES]),
            sql`${sequenceDispatchModel.stepId} IS DISTINCT FROM ${currentStep.id}`,
          ),
        )
        .limit(1)
      if (ahead) {
        return []
      }
      if (!nextStep) {
        await tx
          .update(contactsOnSequenceModel)
          .set({
            status: "completed",
            completedAt: sentAt,
            currentStep: currentStep.order + 1,
            lastStepId: currentStep.id,
            nextStepId: null,
            nextRunAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(contactsOnSequenceModel.id, enrollmentId),
              eq(contactsOnSequenceModel.workspaceId, workspaceId),
            ),
          )
        return []
      }
      const scheduled = calculateNextRunAt(nextStep, sentAt)
      // The pause end, moved into the step's send window (Codex s226b).
      const nextRunAt =
        locked?.pausedUntil && locked.pausedUntil > scheduled
          ? calculateNextValidSendTime(locked.pausedUntil, {
              anytime: nextStep.anytime,
              sendTimeStart: nextStep.sendTimeStart,
              sendTimeEnd: nextStep.sendTimeEnd,
              sendDays: nextStep.sendDays,
            })
          : scheduled

      await tx
        .update(contactsOnSequenceModel)
        .set({
          currentStep: nextStep.order,
          lastStepId: currentStep.id,
          nextStepId: nextStep.id,
          nextRunAt,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(contactsOnSequenceModel.id, enrollmentId),
            eq(contactsOnSequenceModel.workspaceId, workspaceId),
          ),
        )

      const contactInboxes = await getDispatchContactInboxes(
        workspaceId,
        contactId,
      )
      const nextDispatches: DispatchToSchedule[] = []

      for (const contactInbox of contactInboxes) {
        const nextDispatch = await createDispatch({
          workspaceId,
          sequenceId,
          contactId,
          stepId: nextStep.id,
          enrollmentId,
          runAt: nextRunAt,
          client: tx,
          contactInboxId: contactInbox.id,
        })

        nextDispatches.push(nextDispatch)
      }

      return nextDispatches
    })
    .catch((err: unknown) => {
      // Removed between the read above and the dispatch insert.
      if (
        isForeignKeyViolationError(
          err,
          "SequenceDispatch_enrollment_workspace_fkey",
        )
      ) {
        throw new EnrollmentNotFoundError(enrollmentId)
      }
      throw err
    })

  for (const dispatch of dispatches) {
    await scheduler.addToSchedule(
      dispatch.bucket,
      dispatch.id,
      Number(dispatch.runAtMs),
    )
  }
}
