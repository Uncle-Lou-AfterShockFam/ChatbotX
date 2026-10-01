// @vitest-environment node

/**
 * s236: editing a sequence's steps, against a REAL Postgres.
 * - Owner decision (Lou, 2026-10-01): adding or re-activating a step never
 *   reopens a contact who FINISHED the sequence. Upstream reopened every
 *   finished enrolment and sent the step at once (run time = enrolledAt +
 *   delays, in the past): live s236, a finished outreach got a new mail.
 * - Blind probe s236: editing the last step's delay, or disabling it, while
 *   its dispatch was still pending COMPLETED the enrolment (and the reopen
 *   queued the step a second time).
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, sql } from "@chatbotx.io/database/client"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"

vi.mock("@chatbotx.io/redis", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/redis")>()),
  sequenceConnections: { useExisting: async () => ({ fake: true }) },
}))
vi.mock("@chatbotx.io/scheduler", () => ({
  SchedulerClient: class {
    addToSchedule = vi.fn().mockResolvedValue(undefined)
    removeFromSchedule = vi.fn().mockResolvedValue(undefined)
  },
}))
vi.mock("@chatbotx.io/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/events")>()),
  emitSequenceUnsubscribed: vi.fn().mockResolvedValue(undefined),
  emitSequenceSubscribed: vi.fn().mockResolvedValue(undefined),
}))

const { sequenceService } = await import("../../src/sequence")

const databaseUrl = requireRealDatabaseUrl()

/** Ids far above any snowflake a scratch database would hold (own range). */
let nextId = 9_236_200_000_000_000n
function mintId(): string {
  nextId += 1n
  return nextId.toString()
}

const seeded: Record<string, string[]> = {
  SequenceDispatch: [],
  ContactOnSequence: [],
  SequenceStep: [],
  ContactInbox: [],
  Inbox: [],
  Contact: [],
  Sequence: [],
  Workspace: [],
}

async function asReplica(statement: ReturnType<typeof sql>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`)
    await tx.execute(statement)
  })
}

type Seed = {
  workspaceId: string
  sequenceId: string
  steps: string[]
  enrollmentId: string
}

/**
 * Steps 0..stepCount-1 (1-min delays, the last `inactiveTail` inactive) and
 * one enrolment: `finished` = completed past the active steps; otherwise
 * active at `atStep` with a PENDING dispatch for it.
 */
async function seed(props: {
  stepCount: number
  inactiveTail?: number
  finished?: boolean
  atStep?: number
}): Promise<Seed> {
  const workspaceId = mintId()
  const sequenceId = mintId()
  const contactId = mintId()
  const enrollmentId = mintId()
  const inboxId = mintId()
  const contactInboxId = mintId()
  await asReplica(sql`
    INSERT INTO "Workspace" (id, name, "ownerId")
    VALUES (${workspaceId}, 's236 step edit', ${mintId()})`)
  seeded.Workspace?.push(workspaceId)
  await asReplica(sql`
    INSERT INTO "Contact" (id, "workspaceId") VALUES (${contactId}, ${workspaceId})`)
  seeded.Contact?.push(contactId)
  await asReplica(sql`
    INSERT INTO "Sequence" (id, name, "workspaceId")
    VALUES (${sequenceId}, ${`s236 ${sequenceId}`}, ${workspaceId})`)
  seeded.Sequence?.push(sequenceId)
  const steps: string[] = []
  const activeCount = props.stepCount - (props.inactiveTail ?? 0)
  for (let order = 0; order < props.stepCount; order++) {
    const stepId = mintId()
    await asReplica(sql`
      INSERT INTO "SequenceStep"
        (id, "sequenceId", "order", "delayDays", "delayMinutes", "delayUnit", anytime, "isActive")
      VALUES (${stepId}, ${sequenceId}, ${order}, 0, 1, 'minutes', true, ${order < activeCount})`)
    seeded.SequenceStep?.push(stepId)
    steps.push(stepId)
  }
  await asReplica(sql`
    INSERT INTO "Inbox" (id, "workspaceId", name, channel, "sourceId")
    VALUES (${inboxId}, ${workspaceId}, 's236', 'api', ${`s236-${inboxId}`})`)
  seeded.Inbox?.push(inboxId)
  await asReplica(sql`
    INSERT INTO "ContactInbox"
      (id, "contactId", "inboxId", "originalContactId", channel, source,
       "sourceId", "lastIncomingMessageAt")
    VALUES (${contactInboxId}, ${contactId}, ${inboxId}, ${contactId}, 'api',
            'api', ${`s236-${contactInboxId}`}, now() - interval '5 minutes')`)
  seeded.ContactInbox?.push(contactInboxId)
  if (props.finished) {
    await asReplica(sql`
      INSERT INTO "ContactOnSequence"
        (id, "contactId", "sequenceId", "workspaceId", status, "currentStep",
         "lastStepId", "enrolledAt", "completedAt")
      VALUES (${enrollmentId}, ${contactId}, ${sequenceId}, ${workspaceId},
              'completed', ${activeCount}, ${steps[activeCount - 1] ?? null},
              now() - interval '7 hours', now() - interval '6 hours')`)
    seeded.ContactOnSequence?.push(enrollmentId)
  } else {
    const atStep = props.atStep ?? 0
    const dispatchId = mintId()
    await asReplica(sql`
      INSERT INTO "ContactOnSequence"
        (id, "contactId", "sequenceId", "workspaceId", status, "currentStep",
         "nextStepId", "nextRunAt", "enrolledAt")
      VALUES (${enrollmentId}, ${contactId}, ${sequenceId}, ${workspaceId},
              'active', ${atStep}, ${steps[atStep] ?? null},
              now() + interval '10 minutes', now() - interval '1 hour')`)
    seeded.ContactOnSequence?.push(enrollmentId)
    await asReplica(sql`
      INSERT INTO "SequenceDispatch"
        (id, "runAtMs", "idempotencyKey", "workspaceId", "sequenceId",
         "contactId", "contactInboxId", "stepId", "enrollmentId", status)
      VALUES (${dispatchId}, ${Date.now() + 600_000}, ${`s236-${dispatchId}`},
              ${workspaceId}, ${sequenceId}, ${contactId}, ${contactInboxId},
              ${steps[atStep] ?? null}, ${enrollmentId}, 'pending')`)
    seeded.SequenceDispatch?.push(dispatchId)
  }
  return { workspaceId, sequenceId, steps, enrollmentId }
}

afterEach(async () => {
  if (!databaseUrl) {
    return
  }
  const sequenceIds = seeded.Sequence ?? []
  if (sequenceIds.length > 0) {
    await asReplica(sql`
      DELETE FROM "SequenceDispatch" WHERE "sequenceId" IN (${sql.join(
        sequenceIds.map((id) => sql`${id}`),
        sql`, `,
      )})`)
  }
  for (const table of Object.keys(seeded)) {
    const ids = seeded[table]?.splice(0) ?? []
    if (ids.length > 0) {
      await asReplica(sql`
        DELETE FROM ${sql.identifier(table)}
         WHERE id IN (${sql.join(
           ids.map((id) => sql`${id}`),
           sql`, `,
         )})`)
    }
  }
})

afterAll(async () => {
  if (databaseUrl) {
    await db.$client.end()
  }
})

const state = async (s: Seed) => {
  const enrolment = (
    await db.execute<{ status: string; completedAt: unknown }>(sql`
      SELECT status, "completedAt" FROM "ContactOnSequence" WHERE id = ${s.enrollmentId}`)
  ).rows[0]
  const live = (
    await db.execute<{ stepId: string }>(sql`
      SELECT "stepId"::text AS "stepId" FROM "SequenceDispatch"
       WHERE "enrollmentId" = ${s.enrollmentId}
         AND status IN ('pending', 'running', 'held')`)
  ).rows
  return { status: enrolment?.status, live: live.map((r) => r.stepId) }
}

describe.skipIf(!databaseUrl)("editing sequence steps (s236)", () => {
  test("adding a step never reopens a contact who finished the sequence", async () => {
    const s = await seed({ stepCount: 2, finished: true })
    await sequenceService.upsertStep({
      workspaceId: s.workspaceId,
      sequenceId: s.sequenceId,
      data: { order: 2, delayMinutes: 1, delayUnit: "minutes", anytime: true },
    })
    expect(await state(s)).toEqual({ status: "completed", live: [] })
  })

  test("re-activating a step never reopens a contact who finished (live s236)", async () => {
    const s = await seed({ stepCount: 3, inactiveTail: 1, finished: true })
    await sequenceService.upsertStep({
      workspaceId: s.workspaceId,
      sequenceId: s.sequenceId,
      stepId: s.steps[2],
      data: { order: 2, isActive: true, delayMinutes: 2, delayUnit: "minutes" },
    })
    expect(await state(s)).toEqual({ status: "completed", live: [] })
  })

  test("probe D3: editing the LAST step's delay while it is pending keeps the enrolment active with ONE dispatch", async () => {
    const s = await seed({ stepCount: 3, atStep: 2 })
    await sequenceService.upsertStep({
      workspaceId: s.workspaceId,
      sequenceId: s.sequenceId,
      stepId: s.steps[2],
      data: { order: 2, delayMinutes: 5, delayUnit: "minutes" },
    })
    expect(await state(s)).toEqual({ status: "active", live: [s.steps[2]] })
  })

  test("probe D4c: disabling the pending last step leaves its dispatch to finish the enrolment, and re-enabling it adds no second one", async () => {
    const s = await seed({ stepCount: 3, atStep: 2 })
    await sequenceService.upsertStep({
      workspaceId: s.workspaceId,
      sequenceId: s.sequenceId,
      stepId: s.steps[2],
      data: { order: 2, isActive: false },
    })
    expect(await state(s)).toEqual({ status: "active", live: [s.steps[2]] })
    await sequenceService.upsertStep({
      workspaceId: s.workspaceId,
      sequenceId: s.sequenceId,
      stepId: s.steps[2],
      data: { order: 2, isActive: true },
    })
    expect(await state(s)).toEqual({ status: "active", live: [s.steps[2]] })
  })

  test("a contact with nothing left to run (no live dispatch, no active step ahead) is still completed", async () => {
    const s = await seed({ stepCount: 3, atStep: 2 })
    await db.execute(
      sql`UPDATE "SequenceDispatch" SET status = 'canceled' WHERE "enrollmentId" = ${s.enrollmentId}`,
    )
    await sequenceService.upsertStep({
      workspaceId: s.workspaceId,
      sequenceId: s.sequenceId,
      stepId: s.steps[2],
      data: { order: 2, isActive: false },
    })
    expect((await state(s)).status).toBe("completed")
  })
})
