import {
  and,
  asc,
  db,
  eq,
  gt,
  isForeignKeyViolationError,
} from "@chatbotx.io/database/client"
import {
  contactsOnSequenceModel,
  sequenceStepModel,
} from "@chatbotx.io/database/schema"
import type { SchedulerClient } from "@chatbotx.io/scheduler"
import { calculateNextRunAtFromStep } from "./calculate-next-run-at"
import { getDispatchContactInboxes } from "./contacts-on-sequences"
import { createDispatch } from "./dispatch-manager"
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
 * The enrolment row is gone: it was removed (unsubscribe, company stop,
 * sequence stop-on-reply) after the dispatch was claimed.
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

  if (!nextStep) {
    await db
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
    return
  }

  const dispatches = await db
    .transaction(async (tx) => {
      // s226b: an out-of-office pause holds the next step. Read under the
      // row lock the pause also takes, so a pause landing now either sees
      // this dispatch (and moves it) or is seen here.
      const [locked] = await tx
        .select({ pausedUntil: contactsOnSequenceModel.pausedUntil })
        .from(contactsOnSequenceModel)
        .where(
          and(
            eq(contactsOnSequenceModel.id, enrollmentId),
            eq(contactsOnSequenceModel.workspaceId, workspaceId),
          ),
        )
        .for("update")
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
