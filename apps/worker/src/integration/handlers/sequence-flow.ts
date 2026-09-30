import { contactSequenceService } from "@chatbotx.io/business/contact-sequence"
import { sequenceConnections } from "@chatbotx.io/redis"
import { SchedulerClient } from "@chatbotx.io/scheduler"
import {
  advanceEnrollment,
  EnrollmentNotFoundError,
} from "@chatbotx.io/sequence-scheduler"
import type { IntegrationJobSendSequenceFlow } from "@chatbotx.io/worker-config"
import type { Job } from "bullmq"
import { isFinalAttempt } from "../../lib/job-attempts"
import { logger } from "../../lib/logger"
import { StepExecutorService } from "../../sequence-scheduler/services/step-executor.service"
import { sendFlowDirect } from "./send-flow-direct"
import { missingHoldFields } from "./sequence-hold"

type SendSequenceFlowData = IntegrationJobSendSequenceFlow["data"]

let schedulerClient: SchedulerClient | null = null
const stepExecutor = new StepExecutorService()

async function getSchedulerClient(): Promise<SchedulerClient> {
  if (!schedulerClient) {
    const redis = await sequenceConnections.useExisting()
    schedulerClient = new SchedulerClient(redis)
  }
  return schedulerClient
}

async function fetchDispatch(dispatchId: string, workspaceId: string) {
  return await contactSequenceService.findRunningDispatch({
    dispatchId,
    workspaceId,
  })
}

async function markDispatchCompleted(
  dispatchId: string,
  workspaceId: string,
  sentAt: Date,
): Promise<void> {
  await contactSequenceService.markDispatchCompleted({
    dispatchId,
    workspaceId,
    sentAt,
  })
}

async function markDispatchCanceled(
  dispatchId: string,
  workspaceId: string,
  reason: string,
): Promise<void> {
  await contactSequenceService.markDispatchCanceled({
    dispatchId,
    workspaceId,
    reason,
  })
}

async function markDispatchFailed(
  dispatchId: string,
  workspaceId: string,
  errorMessage: string,
): Promise<void> {
  await contactSequenceService.markDispatchFailed({
    dispatchId,
    workspaceId,
    errorMessage,
  })
}

async function runSendSequenceFlow(
  data: SendSequenceFlowData,
  job: Job,
): Promise<void> {
  const { dispatchId, workspaceId, stepId, bucket, contactId, sequenceId } =
    data

  const dispatch = await fetchDispatch(dispatchId, workspaceId)
  if (!dispatch) {
    return
  }

  const step = await stepExecutor.fetchStep(stepId)
  const validation = stepExecutor.validateStep(step)
  const scheduler = await getSchedulerClient()

  if (!validation.valid) {
    await markDispatchCanceled(dispatchId, workspaceId, validation.reason)

    if (step) {
      await advanceEnrollment({
        enrollmentId: data.enrollmentId,
        workspaceId,
        sequenceId,
        contactId,
        currentStep: { id: step.id, order: step.order },
        sentAt: new Date(),
        scheduler,
      })
    }

    await scheduler.removeFromSchedule(bucket, dispatchId)
    return
  }

  const validStep = validation.step
  const completedAt = dispatch.completedAt

  let sentAt: Date
  if (completedAt) {
    sentAt = completedAt
  } else {
    // Re-read right before sending: the enrolment may have been removed (a
    // stop-on-reply reply, an unsubscribe) while the step was looked up, and
    // its dispatch cascades away with it.
    const current = await fetchDispatch(dispatchId, workspaceId)
    if (!current) {
      await scheduler.removeFromSchedule(bucket, dispatchId)
      return
    }
    // s226b: an out-of-office paused the enrolment after this step was
    // claimed (or an advance raced the pause): hold it, never send it now.
    const deferred = await contactSequenceService.deferIfPaused({
      dispatchId,
      workspaceId,
    })
    if (deferred) {
      await scheduler.addToSchedule(
        deferred.bucket,
        dispatchId,
        deferred.runAtMs,
      )
      logger.info(
        { dispatchId, workspaceId, runAtMs: deferred.runAtMs },
        "sendSequenceFlow: enrolment paused (out-of-office), step held",
      )
      return
    }
    // s227b outreach B-1 H3: a step whose required contact fields are not
    // all set HOLDS the enrolment (reason shown) instead of running its flow;
    // nothing of the flow runs. An operator resumes it.
    const missing = await missingHoldFields({
      holdOnMissing: validStep.holdOnMissing,
      contactId: data.contactId,
      contactInboxId: current.contactInboxId,
    })
    if (missing.length > 0) {
      const held = await contactSequenceService.holdEnrollment({
        dispatchId,
        workspaceId,
        reason: `missing: ${missing.join(", ")}`,
      })
      if (!held) {
        // No longer running, or the enrolment is not active: send nothing.
        await markDispatchCanceled(dispatchId, workspaceId, "not_active")
      }
      await scheduler.removeFromSchedule(bucket, dispatchId)
      logger.info(
        { dispatchId, workspaceId, missing, held },
        "sendSequenceFlow: required fields missing, enrolment held",
      )
      return
    }
    const { companyStopped } = await sendFlowDirect({
      flowId: validStep.flow.id,
      workspaceId,
      contactId: data.contactId,
      contactInboxId: current.contactInboxId,
      metadata: data.metadata,
      flowExecutionKey: job.id,
      startedAt: new Date(job.timestamp),
    })
    if (companyStopped) {
      // Nothing was sent: never record a send or advance the enrollment (the
      // stop's sequence phase ends it; a partial stop must not queue a step).
      await markDispatchCanceled(dispatchId, workspaceId, "company_stopped")
      await scheduler.removeFromSchedule(bucket, dispatchId)
      return
    }

    sentAt = new Date()
    await markDispatchCompleted(dispatchId, workspaceId, sentAt)
  }

  try {
    await advanceEnrollment({
      enrollmentId: data.enrollmentId,
      workspaceId,
      sequenceId,
      contactId,
      currentStep: { id: validStep.id, order: validStep.order },
      sentAt,
      scheduler,
    })
  } catch (err) {
    // The enrolment was removed (a stop-on-reply reply, an unsubscribe, a
    // company stop) while this step was sending: its dispatch cascaded away,
    // so there is nothing to advance and nothing a retry could do.
    if (!(err instanceof EnrollmentNotFoundError)) {
      throw err
    }
    logger.info(
      { dispatchId, enrollmentId: data.enrollmentId, workspaceId },
      "sendSequenceFlow: enrolment removed while the step was sending",
    )
  }

  await scheduler.removeFromSchedule(bucket, dispatchId)
}

async function safeTerminalCleanup(
  data: SendSequenceFlowData,
  err: unknown,
  job: Job,
): Promise<void> {
  const { dispatchId, workspaceId, bucket } = data
  const message = err instanceof Error ? err.message : "Unknown error"

  try {
    await markDispatchFailed(dispatchId, workspaceId, message)
  } catch (error) {
    logger.error(
      { error, dispatchId, jobId: job.id },
      "markDispatchFailed failed in terminal cleanup",
    )
  }

  try {
    const scheduler = await getSchedulerClient()
    await scheduler.removeFromSchedule(bucket, dispatchId)
  } catch (error) {
    logger.error(
      { error, dispatchId, jobId: job.id },
      "removeFromSchedule failed in terminal cleanup",
    )
  }
}

export async function handleSendSequenceFlow(
  data: SendSequenceFlowData,
  job: Job,
): Promise<void> {
  try {
    await runSendSequenceFlow(data, job)
  } catch (err) {
    const finalAttempt = isFinalAttempt(job)

    logger.error(
      {
        err,
        dispatchId: data.dispatchId,
        jobId: job.id,
        attempt: job.attemptsMade + 1,
        isFinalAttempt: finalAttempt,
      },
      "sendSequenceFlow handler failed",
    )

    if (finalAttempt) {
      await safeTerminalCleanup(data, err, job)
    }

    throw err
  }
}
