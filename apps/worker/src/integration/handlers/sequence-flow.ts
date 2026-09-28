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
    if (!(await fetchDispatch(dispatchId, workspaceId))) {
      await scheduler.removeFromSchedule(bucket, dispatchId)
      return
    }
    const { companyStopped } = await sendFlowDirect({
      flowId: validStep.flow.id,
      workspaceId,
      contactId: data.contactId,
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
