import {
  and,
  type DatabaseClient,
  db,
  eq,
  isNull,
  lte,
  sql,
} from "@chatbotx.io/database/client"
import { contactsOnSequenceModel } from "@chatbotx.io/database/schema"

type SequenceStepForDelay = {
  id: string
  order: number
  sequenceId?: string
  delayDays: number
  delayMinutes: number
  delayUnit: string | null
  specificDateTime: Date | null
}

function calculateDelayInMs(delayDays: number, delayMinutes: number): number {
  return delayDays * 24 * 60 * 60 * 1000 + delayMinutes * 60 * 1000
}

async function getActiveStepsForSequence(
  sequenceId: string,
  client: DatabaseClient,
): Promise<SequenceStepForDelay[]> {
  return await client.query.sequenceStepModel.findMany({
    where: {
      sequenceId,
      isActive: true,
    },
    orderBy: {
      order: "asc",
    },
    columns: {
      id: true,
      order: true,
      delayDays: true,
      delayMinutes: true,
      delayUnit: true,
      specificDateTime: true,
    },
  })
}

async function getActiveStepsCumulativeDelay(
  sequenceId: string,
  upToOrder: number,
  client: DatabaseClient,
): Promise<number | Date> {
  const steps = await getActiveStepsForSequence(sequenceId, client)

  if (steps.length === 0) {
    return -1
  }

  const stepsUpToTarget = steps.filter((s) => s.order <= upToOrder)

  if (stepsUpToTarget.length === 0) {
    return -1
  }

  const targetStep = stepsUpToTarget.at(-1)

  if (
    targetStep &&
    targetStep.delayUnit === "specificTime" &&
    targetStep.specificDateTime
  ) {
    return targetStep.specificDateTime
  }

  let totalDelayMs = 0
  for (const step of stepsUpToTarget) {
    totalDelayMs += calculateDelayInMs(step.delayDays, step.delayMinutes)
  }

  return totalDelayMs
}

async function getNextActiveStep(
  sequenceId: string,
  fromOrder: number,
  client: DatabaseClient,
): Promise<{ id: string; order: number } | null> {
  const nextStep = await client.query.sequenceStepModel.findFirst({
    where: {
      sequenceId,
      order: { gte: fromOrder },
      isActive: true,
    },
    orderBy: {
      order: "asc",
    },
    columns: { id: true, order: true },
  })
  return nextStep ?? null
}

type UpdateContactsNextRunAtParams = {
  sequenceId: string
  workspaceId: string
  currentStepOrder: number
  delayMsOrDate: number | Date
  nextStepId: string | null
  client: DatabaseClient
}

/**
 * s226b (skeptic): a step edit never shows an out-of-office-paused enrolment
 * as due before its pause ends (GREATEST ignores a NULL pausedUntil).
 */
const notBeforePause = (value: ReturnType<typeof sql>) =>
  sql`GREATEST(${value}, ${contactsOnSequenceModel.pausedUntil})`

async function updateContactsNextRunAt(params: UpdateContactsNextRunAtParams) {
  const {
    sequenceId,
    workspaceId,
    currentStepOrder,
    delayMsOrDate,
    nextStepId,
    client,
  } = params

  const whereCondition = and(
    eq(contactsOnSequenceModel.sequenceId, sequenceId),
    eq(contactsOnSequenceModel.workspaceId, workspaceId),
    eq(contactsOnSequenceModel.currentStep, currentStepOrder),
    eq(contactsOnSequenceModel.status, "active"),
    isNull(contactsOnSequenceModel.completedAt),
  )

  if (delayMsOrDate === -1) {
    await client
      .update(contactsOnSequenceModel)
      .set({
        nextRunAt: null,
        nextStepId,
        updatedAt: new Date(),
      })
      .where(whereCondition)
  } else if (delayMsOrDate instanceof Date) {
    await client
      .update(contactsOnSequenceModel)
      .set({
        nextRunAt: notBeforePause(sql`${delayMsOrDate}`),
        nextStepId,
        updatedAt: new Date(),
      })
      .where(whereCondition)
  } else {
    await client
      .update(contactsOnSequenceModel)
      .set({
        nextRunAt: notBeforePause(
          sql`NOW() + INTERVAL '${sql.raw(String(delayMsOrDate))} milliseconds'`,
        ),
        nextStepId,
        updatedAt: new Date(),
      })
      .where(whereCondition)
  }
}

async function recalculateNextRunAtForStep(
  sequenceId: string,
  workspaceId: string,
  stepOrder: number,
  client: DatabaseClient,
) {
  // Find the NEXT active step after currentStep
  // Contact is at stepOrder, so we need to find the next step they will run
  // Use order > stepOrder (not >=) to get the NEXT step, not current step
  const nextActiveStep = await getNextActiveStep(
    sequenceId,
    stepOrder + 1, // Start from NEXT order, not current
    client,
  )

  // If no next active step exists, mark contacts as COMPLETED
  // They have finished all available steps in the sequence
  if (nextActiveStep === null) {
    await client
      .update(contactsOnSequenceModel)
      .set({
        status: "completed",
        completedAt: new Date(),
        nextRunAt: null,
        nextStepId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(contactsOnSequenceModel.sequenceId, sequenceId),
          eq(contactsOnSequenceModel.workspaceId, workspaceId),
          eq(contactsOnSequenceModel.currentStep, stepOrder),
          eq(contactsOnSequenceModel.status, "active"),
          isNull(contactsOnSequenceModel.completedAt),
          // s236 (probe): never complete an enrolment whose step at
          // `currentStep` (the NEXT one to run) is still active, nor one with
          // a live dispatch: editing the last step's delay, or disabling the
          // step after it, completed a contact whose last mail was still
          // pending (and a reopen then queued it a second time). The send or
          // its advance completes it.
          sql`NOT EXISTS (SELECT 1 FROM "SequenceStep" st WHERE st."sequenceId" = ${sequenceId} AND st."isActive" = true AND st."order" >= ${stepOrder})`,
          sql`NOT EXISTS (SELECT 1 FROM "SequenceDispatch" sd WHERE sd."workspaceId" = ${contactsOnSequenceModel.workspaceId} AND sd."enrollmentId" = ${contactsOnSequenceModel.id} AND sd."status" IN ('pending', 'running', 'held'))`,
        ),
      )
    return
  }

  // Calculate cumulative delay from start to the next step
  const cumulativeDelay = await getActiveStepsCumulativeDelay(
    sequenceId,
    nextActiveStep.order,
    client,
  )

  // Update contacts at this currentStep position
  await updateContactsNextRunAt({
    sequenceId,
    workspaceId,
    currentStepOrder: stepOrder,
    delayMsOrDate: cumulativeDelay,
    nextStepId: nextActiveStep.id,
    client,
  })
}

/**
 * Recalculate schedules for all active contacts in a sequence.
 * This is called when steps are added, updated, or deleted.
 *
 * Handles:
 * - Active contacts (status='active', completedAt=null): recalculate nextRunAt
 * - Completed contacts (status='completed' or completedAt!=null): no changes
 * - Contacts at different currentStep positions: each gets appropriate nextRunAt
 */
export async function recalculateAllContactsInSequence(
  sequenceId: string,
  workspaceId: string,
  tx?: DatabaseClient,
) {
  const client = tx ?? db

  // Only recalculate for active, non-completed contacts
  // Completed contacts remain finished and are not affected by step changes
  const uniqueSteps = await client
    .selectDistinct({ currentStep: contactsOnSequenceModel.currentStep })
    .from(contactsOnSequenceModel)
    .where(
      and(
        eq(contactsOnSequenceModel.sequenceId, sequenceId),
        eq(contactsOnSequenceModel.workspaceId, workspaceId),
        eq(contactsOnSequenceModel.status, "active"),
        isNull(contactsOnSequenceModel.completedAt),
      ),
    )

  // Recalculate for each unique currentStep position
  // This handles contacts at different stages of the sequence
  for (const { currentStep } of uniqueSteps) {
    await recalculateNextRunAtForStep(
      sequenceId,
      workspaceId,
      currentStep,
      client,
    )
  }
}

/**
 * Handle step CREATION impact on contacts.
 *
 * SCENARIOS:
 *
 * Case 1: Contact at step 2, create new step order=5 (0-based: 3rd vs 6th step)
 *   - Contact currentStep=2 < newStepOrder=5
 *   - ✅ RECALCULATE: Contact will reach step 5 in the future
 *   - nextRunAt needs recalculation to include new step 5's delay
 *
 * Case 2: Contact at step 7, create new step order=5 (0-based: 8th vs 6th step)
 *   - Contact currentStep=7 > newStepOrder=5
 *   - ❌ SKIP: Contact already passed step 5, won't go back
 *   - No impact on this contact
 *
 * Case 3: Contact at step 5, create new step order=5 (0-based: same position)
 *   - Contact currentStep=5 = newStepOrder=5
 *   - ✅ RECALCULATE: New step may change timeline
 *   - Need to recalculate nextRunAt for this contact
 *
 * Case 4: Contact status='completed' (finished before the step was added)
 *   - ❌ SKIP (owner s236): a finished contact stays finished. Upstream
 *     reopened it and sent the new step AT ONCE (its run time was
 *     enrolledAt + delays, in the past): editing an old sequence mailed
 *     everyone who had finished it.
 *
 * Case 5: Contact status='paused' or 'cancelled'
 *   - ❌ SKIP: Only process active and completed contacts
 */
export async function handleStepCreationImpact(
  sequenceId: string,
  workspaceId: string,
  newStepOrder: number,
  tx?: DatabaseClient,
) {
  const client = tx ?? db

  // PART 1: Handle ACTIVE contacts
  // Query: Get all active contacts AFFECTED by the new step
  // Conditions:
  // 1. status = 'active' AND completedAt IS NULL (only active contacts)
  // 2. currentStep <= newStepOrder (haven't passed new step or currently at new step)
  //    Note: Order is 0-based, so step 0 is the first step
  const affectedSteps = await client
    .selectDistinct({ currentStep: contactsOnSequenceModel.currentStep })
    .from(contactsOnSequenceModel)
    .where(
      and(
        eq(contactsOnSequenceModel.sequenceId, sequenceId),
        eq(contactsOnSequenceModel.workspaceId, workspaceId),
        eq(contactsOnSequenceModel.status, "active"),
        isNull(contactsOnSequenceModel.completedAt),
        lte(contactsOnSequenceModel.currentStep, newStepOrder),
      ),
    )

  // Recalculate nextRunAt for each affected currentStep position (0-based)
  // Use Promise.all for parallel processing to improve performance
  await Promise.all(
    affectedSteps.map(({ currentStep }) =>
      recalculateNextRunAtForStep(sequenceId, workspaceId, currentStep, client),
    ),
  )
}

/**
 * Handle step UPDATE impact on contacts.
 *
 * SCENARIOS:
 *
 * Case 1: Update delay of step 3 (1 day → 3 days)
 *   - Contact A: currentStep=2, nextStepId=step3.id, nextRunAt=tomorrow
 *   - ✅ RECALCULATE: Contact is waiting for step 3
 *   - nextRunAt: tomorrow → 3 days later
 *
 * Case 2: Update delay of step 5
 *   - Contact B: currentStep=2, nextStepId=step3.id
 *   - ✅ RECALCULATE: Contact will reach step 5 later
 *   - Cumulative delay changes, need to recalculate timeline
 *
 * Case 3: Disable step 3 (isActive: true → false)
 *   - Contact C: currentStep=2, nextStepId=step3.id
 *   - ✅ RECALCULATE: Step 3 is no longer active
 *   - nextStepId → step4.id (next active step)
 *
 * Case 4: Enable step 3 (isActive: false → true)
 *   - Contact D: currentStep=2, nextStepId=step4.id
 *   - ✅ RECALCULATE: Step 3 is now available
 *   - nextStepId may → step3.id (if step 3 is next active)
 *
 * Case 5: Update step 7, contact currently at step 2
 *   - Contact E: currentStep=2 < updatedStepOrder=7
 *   - ✅ RECALCULATE: Contact will reach step 7 in the future
 *
 * Case 6: Update step 3, contact already at step 8
 *   - Contact F: currentStep=8 > updatedStepOrder=3
 *   - ❌ SKIP: Contact already passed step 3
 *
 * Case 7: Update flowId of step (does not affect scheduling)
 *   - ❌ THIS FUNCTION IS NOT CALLED
 *   - shouldRecalculateOnUpdate() = false
 *
 * Case 8: Contact status='completed'
 *   - ❌ SKIP (owner s236): enabling or reordering a step never reopens a
 *     finished contact (see handleStepCreationImpact case 4).
 */
export async function handleStepUpdateImpact(
  sequenceId: string,
  workspaceId: string,
  updatedStepId: string,
  updatedStepOrder: number,
  tx?: DatabaseClient,
) {
  const client = tx ?? db

  // PART 1: Handle ACTIVE contacts
  // GROUP 1: Contacts WAITING FOR this step (nextStepId = updatedStepId)
  // Example: Contact at step 2, nextStepId = step3.id
  //          → Update step 3 → need immediate recalculation
  const contactsWaitingForStep = await client
    .selectDistinct({ currentStep: contactsOnSequenceModel.currentStep })
    .from(contactsOnSequenceModel)
    .where(
      and(
        eq(contactsOnSequenceModel.sequenceId, sequenceId),
        eq(contactsOnSequenceModel.workspaceId, workspaceId),
        eq(contactsOnSequenceModel.status, "active"),
        isNull(contactsOnSequenceModel.completedAt),
        eq(contactsOnSequenceModel.nextStepId, updatedStepId),
      ),
    )

  // GROUP 2: Contacts at EARLIER STEPS (currentStep < updatedStepOrder)
  // Example: Contact at step 2, update step 5
  //          → Contact will reach step 5 later → need recalculation
  // Reason: Cumulative delay from step 2 → step 5 may change
  const contactsBeforeStep = await client
    .selectDistinct({ currentStep: contactsOnSequenceModel.currentStep })
    .from(contactsOnSequenceModel)
    .where(
      and(
        eq(contactsOnSequenceModel.sequenceId, sequenceId),
        eq(contactsOnSequenceModel.workspaceId, workspaceId),
        eq(contactsOnSequenceModel.status, "active"),
        isNull(contactsOnSequenceModel.completedAt),
        sql`${contactsOnSequenceModel.currentStep} < ${updatedStepOrder}`,
      ),
    )

  // Merge 2 groups and deduplicate
  // Example: Contact at step 2 may be in both GROUP 1 (nextStepId=step3.id)
  //          and GROUP 2 (currentStep < updatedStepOrder)
  //          → Only recalculate once
  const allAffectedSteps = [
    ...contactsWaitingForStep,
    ...contactsBeforeStep,
  ].reduce(
    (acc, { currentStep }) => {
      if (!acc.some((s) => s.currentStep === currentStep)) {
        acc.push({ currentStep })
      }
      return acc
    },
    [] as { currentStep: number }[],
  )

  // Recalculate nextRunAt for each affected currentStep position
  // Use Promise.all for parallel processing to improve performance
  await Promise.all(
    allAffectedSteps.map(({ currentStep }) =>
      recalculateNextRunAtForStep(sequenceId, workspaceId, currentStep, client),
    ),
  )
}
