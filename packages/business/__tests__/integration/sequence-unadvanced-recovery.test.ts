// @vitest-environment node

/**
 * s236: an enrolment whose step was SENT and marked completed but never
 * ADVANCED (the worker died, or `advanceEnrollment` threw, between
 * `markDispatchCompleted` and the advance) is recovered, against a REAL
 * Postgres.
 *
 * The send job's retry used to find no `running` dispatch and stop, and the
 * s235 stalled pass skips it (a completed dispatch for its step exists this
 * cycle), so the enrolment stayed "active" forever. The recovery advances it
 * exactly once, and never from a dispatch the enrolment has moved past.
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, sql } from "@chatbotx.io/database/client"
import type { SchedulerClient } from "@chatbotx.io/scheduler"
import {
  advanceEnrollment,
  listStalledEnrollments,
  listUnadvancedEnrollments,
  recoverUnadvancedEnrollment,
  STALLED_ENROLLMENT_GRACE_MS,
} from "@chatbotx.io/sequence-scheduler"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"

const databaseUrl = requireRealDatabaseUrl()

/** Ids far above any snowflake a scratch database would hold (own range). */
let nextId = 9_236_100_000_000_000n
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

const MINUTE = 60_000

const fakeScheduler = () =>
  ({
    addToSchedule: vi.fn().mockResolvedValue(undefined),
    removeFromSchedule: vi.fn().mockResolvedValue(undefined),
  }) as unknown as SchedulerClient

type Seed = {
  workspaceId: string
  sequenceId: string
  contactId: string
  contactInboxId: string
  steps: string[]
  enrollmentId: string
  dispatchId: string
}

/**
 * A sequence with `stepCount` anytime steps and one ACTIVE enrolment whose
 * step `atStep` was sent: its dispatch is `completed` at `completedAt`, and
 * the enrolment still points at that step (`currentStep` = its order,
 * `lastStepId` = the step before), the exact state a crash between
 * `markDispatchCompleted` and `advanceEnrollment` leaves.
 */
async function seed(
  props: {
    stepCount?: number
    atStep?: number
    completedAt?: Date
    pausedUntil?: Date
    status?: "completed" | "failed" | "canceled"
  } = {},
): Promise<Seed> {
  const workspaceId = mintId()
  const sequenceId = mintId()
  const contactId = mintId()
  const enrollmentId = mintId()
  const dispatchId = mintId()
  const inboxId = mintId()
  const contactInboxId = mintId()
  const atStep = props.atStep ?? 0
  const completedAt = props.completedAt ?? new Date(Date.now() - 30 * MINUTE)
  await asReplica(sql`
    INSERT INTO "Workspace" (id, name, "ownerId")
    VALUES (${workspaceId}, 's236 unadvanced', ${mintId()})`)
  seeded.Workspace?.push(workspaceId)
  await asReplica(sql`
    INSERT INTO "Contact" (id, "workspaceId") VALUES (${contactId}, ${workspaceId})`)
  seeded.Contact?.push(contactId)
  await asReplica(sql`
    INSERT INTO "Sequence" (id, name, "workspaceId")
    VALUES (${sequenceId}, ${`s236 ${sequenceId}`}, ${workspaceId})`)
  seeded.Sequence?.push(sequenceId)
  const steps: string[] = []
  for (let order = 0; order < (props.stepCount ?? 3); order++) {
    const stepId = mintId()
    await asReplica(sql`
      INSERT INTO "SequenceStep" (id, "sequenceId", "order", "delayDays", anytime)
      VALUES (${stepId}, ${sequenceId}, ${order}, 0, true)`)
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
  await asReplica(sql`
    INSERT INTO "ContactOnSequence"
      (id, "contactId", "sequenceId", "workspaceId", status, "currentStep",
       "lastStepId", "nextStepId", "nextRunAt", "enrolledAt", "pausedUntil")
    VALUES (${enrollmentId}, ${contactId}, ${sequenceId}, ${workspaceId},
            'active', ${atStep}, ${atStep > 0 ? (steps[atStep - 1] ?? null) : null},
            ${steps[atStep] ?? null},
            ${new Date(completedAt.getTime() - MINUTE).toISOString()},
            now() - interval '2 hours',
            ${props.pausedUntil?.toISOString() ?? null})`)
  seeded.ContactOnSequence?.push(enrollmentId)
  await asReplica(sql`
    INSERT INTO "SequenceDispatch"
      (id, "runAtMs", "idempotencyKey", "workspaceId", "sequenceId",
       "contactId", "contactInboxId", "stepId", "enrollmentId", status,
       "completedAt")
    VALUES (${dispatchId}, ${completedAt.getTime() - MINUTE},
            ${`s236-${dispatchId}`}, ${workspaceId}, ${sequenceId},
            ${contactId}, ${contactInboxId}, ${steps[atStep] ?? null},
            ${enrollmentId}, ${props.status ?? "completed"},
            ${props.status === undefined || props.status === "completed" ? completedAt.toISOString() : null})`)
  seeded.SequenceDispatch?.push(dispatchId)
  return {
    workspaceId,
    sequenceId,
    contactId,
    contactInboxId,
    steps,
    enrollmentId,
    dispatchId,
  }
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

const dispatchesOf = async (enrollmentId: string) =>
  (
    await db.execute<{ id: string; stepId: string; status: string }>(sql`
      SELECT id::text, "stepId"::text AS "stepId", status
        FROM "SequenceDispatch"
       WHERE "enrollmentId" = ${enrollmentId}
       ORDER BY "createdAt", id`)
  ).rows

const enrollmentOf = async (enrollmentId: string) =>
  (
    await db.execute<{
      status: string
      currentStep: number
      lastStepId: string | null
      nextStepId: string | null
    }>(sql`
      SELECT status, "currentStep", "lastStepId"::text AS "lastStepId",
             "nextStepId"::text AS "nextStepId"
        FROM "ContactOnSequence" WHERE id = ${enrollmentId}`)
  ).rows[0]

const isListed = async (s: Seed, now?: Date) =>
  (await listUnadvancedEnrollments({ limit: 1000, now })).some(
    (row) => row.id === s.enrollmentId,
  )

const recover = (s: Seed, scheduler = fakeScheduler()) =>
  recoverUnadvancedEnrollment({
    workspaceId: s.workspaceId,
    enrollmentId: s.enrollmentId,
    scheduler,
  })

describe.skipIf(!databaseUrl)(
  "a sent but never advanced enrolment is recovered (s236)",
  () => {
    test("the crash state is listed, advanced ONCE to the next step, and scheduled", async () => {
      const s = await seed({ atStep: 0 })
      expect(await isListed(s)).toBe(true)
      // The s235 stalled pass does not see it (a completed dispatch for its
      // step exists this cycle): the two passes are disjoint.
      expect(
        (await listStalledEnrollments({ limit: 1000 })).some(
          (row) => row.id === s.enrollmentId,
        ),
      ).toBe(false)

      const scheduler = fakeScheduler()
      expect(await recover(s, scheduler)).toEqual({ kind: "advanced" })
      expect(scheduler.addToSchedule).toHaveBeenCalledTimes(1)
      const rows = await dispatchesOf(s.enrollmentId)
      expect(rows).toHaveLength(2)
      expect(rows[1]).toMatchObject({ stepId: s.steps[1], status: "pending" })
      expect(await enrollmentOf(s.enrollmentId)).toMatchObject({
        status: "active",
        currentStep: 1,
        lastStepId: s.steps[0],
        nextStepId: s.steps[1],
      })
      // Second pass: nothing listed, nothing new.
      expect(await isListed(s)).toBe(false)
      expect(await recover(s)).toEqual({
        kind: "skipped",
        reason: "not-unadvanced",
      })
      expect(await dispatchesOf(s.enrollmentId)).toHaveLength(2)
    })

    test("the LAST step was sent: the enrolment is completed, no dispatch", async () => {
      const s = await seed({ stepCount: 2, atStep: 1 })
      expect(await recover(s)).toEqual({ kind: "advanced" })
      expect(await enrollmentOf(s.enrollmentId)).toMatchObject({
        status: "completed",
        lastStepId: s.steps[1],
      })
      expect(await dispatchesOf(s.enrollmentId)).toHaveLength(1)
    })

    test("inside the grace (an advance may still be on its way): not listed, not advanced", async () => {
      const s = await seed({
        completedAt: new Date(Date.now() - STALLED_ENROLLMENT_GRACE_MS / 2),
      })
      expect(await isListed(s)).toBe(false)
      expect(await recover(s)).toEqual({
        kind: "skipped",
        reason: "not-unadvanced",
      })
      expect(await dispatchesOf(s.enrollmentId)).toHaveLength(1)
    })

    test("a failed or canceled step is never treated as sent", async () => {
      for (const status of ["failed", "canceled"] as const) {
        const s = await seed({ status })
        expect(await isListed(s)).toBe(false)
        expect((await recover(s)).kind).toBe("skipped")
      }
    })

    test("an ended or held enrolment is left alone", async () => {
      for (const status of ["ended", "held"] as const) {
        const s = await seed()
        await db.execute(
          sql`UPDATE "ContactOnSequence" SET status = ${status} WHERE id = ${s.enrollmentId}`,
        )
        expect(await isListed(s)).toBe(false)
        expect((await recover(s)).kind).toBe("skipped")
        expect(await dispatchesOf(s.enrollmentId)).toHaveLength(1)
      }
    })

    test("an out-of-office pause: advanced, the next step waits for the pause end", async () => {
      const pausedUntil = new Date(Date.now() + 14 * 24 * 60 * MINUTE)
      const s = await seed({ pausedUntil })
      expect(await recover(s)).toEqual({ kind: "advanced" })
      const next = (
        await db.execute<{ runAtMs: string }>(sql`
          SELECT "runAtMs"::text AS "runAtMs" FROM "SequenceDispatch"
           WHERE "enrollmentId" = ${s.enrollmentId} AND status = 'pending'`)
      ).rows
      expect(next).toHaveLength(1)
      expect(Number(next[0]?.runAtMs)).toBeGreaterThanOrEqual(
        pausedUntil.getTime(),
      )
    })

    test("a dispatch the enrolment has moved past (an old job redelivered) never advances it again", async () => {
      // The enrolment was advanced past step 0 to step 1 and step 1's
      // dispatch is gone (no live dispatch, the s235 stall shape), then the
      // OLD step-0 job is redelivered: it must not re-queue step 1 from the
      // old dispatch, nor move the pointer backwards.
      const s = await seed({ stepCount: 3, atStep: 0 })
      await db.execute(sql`
        UPDATE "ContactOnSequence"
           SET "currentStep" = 2, "lastStepId" = ${s.steps[1] ?? null},
               "nextStepId" = ${s.steps[2] ?? null}
         WHERE id = ${s.enrollmentId}`)
      const laterId = mintId()
      await asReplica(sql`
        INSERT INTO "SequenceDispatch"
          (id, "runAtMs", "idempotencyKey", "workspaceId", "sequenceId",
           "contactId", "contactInboxId", "stepId", "enrollmentId", status,
           "completedAt")
        VALUES (${laterId}, ${Date.now() - 20 * MINUTE}, ${`s236-${laterId}`},
                ${s.workspaceId}, ${s.sequenceId}, ${s.contactId},
                ${s.contactInboxId}, ${s.steps[1] ?? null}, ${s.enrollmentId},
                'completed', now() - interval '20 minutes')`)
      seeded.SequenceDispatch?.push(laterId)

      expect(
        await advanceEnrollment({
          enrollmentId: s.enrollmentId,
          workspaceId: s.workspaceId,
          sequenceId: s.sequenceId,
          contactId: s.contactId,
          currentStep: { id: s.steps[0] ?? "", order: 0 },
          sentAt: new Date(Date.now() - 30 * MINUTE),
          scheduler: fakeScheduler(),
          afterDispatchId: s.dispatchId,
        }),
      ).toBe(false)
      expect(await enrollmentOf(s.enrollmentId)).toMatchObject({
        currentStep: 2,
        lastStepId: s.steps[1],
      })
      expect(await dispatchesOf(s.enrollmentId)).toHaveLength(2)
    })

    test("the job retry and the reconcile race (8-way): exactly ONE next dispatch", async () => {
      const s = await seed({ atStep: 0 })
      const retry = () =>
        advanceEnrollment({
          enrollmentId: s.enrollmentId,
          workspaceId: s.workspaceId,
          sequenceId: s.sequenceId,
          contactId: s.contactId,
          currentStep: { id: s.steps[0] ?? "", order: 0 },
          sentAt: new Date(Date.now() - 30 * MINUTE),
          scheduler: fakeScheduler(),
          afterDispatchId: s.dispatchId,
        })
      const results = await Promise.allSettled([
        retry(),
        recover(s),
        retry(),
        recover(s),
        retry(),
        recover(s),
        retry(),
        recover(s),
      ])
      expect(results.filter((r) => r.status === "rejected")).toEqual([])
      const live = (await dispatchesOf(s.enrollmentId)).filter(
        (row) => row.status === "pending",
      )
      expect(live).toHaveLength(1)
      expect(live[0]?.stepId).toBe(s.steps[1])
      expect(await enrollmentOf(s.enrollmentId)).toMatchObject({
        currentStep: 1,
        lastStepId: s.steps[0],
      })
    })

    test("probe s236 A2: a failed sibling (same createdAt, higher id) never hides the completed send", async () => {
      const s = await seed({ atStep: 0 })
      const inboxId = mintId()
      const contactInboxId = mintId()
      await asReplica(sql`
        INSERT INTO "Inbox" (id, "workspaceId", name, channel, "sourceId")
        VALUES (${inboxId}, ${s.workspaceId}, 's236', 'api', ${`s236-${inboxId}`})`)
      seeded.Inbox?.push(inboxId)
      await asReplica(sql`
        INSERT INTO "ContactInbox"
          (id, "contactId", "inboxId", "originalContactId", channel, source, "sourceId")
        VALUES (${contactInboxId}, ${s.contactId}, ${inboxId}, ${s.contactId},
                'api', 'api', ${`s236-${contactInboxId}`})`)
      seeded.ContactInbox?.push(contactInboxId)
      const sibling = mintId()
      await asReplica(sql`
        INSERT INTO "SequenceDispatch"
          (id, "runAtMs", "idempotencyKey", "workspaceId", "sequenceId",
           "contactId", "contactInboxId", "stepId", "enrollmentId", status,
           "createdAt")
        SELECT ${sibling}, "runAtMs", ${`s236-${sibling}`}, "workspaceId",
               "sequenceId", "contactId", ${contactInboxId}, "stepId",
               "enrollmentId", 'failed', "createdAt"
          FROM "SequenceDispatch" WHERE id = ${s.dispatchId}`)
      seeded.SequenceDispatch?.push(sibling)
      expect(await isListed(s)).toBe(true)
      expect(await recover(s)).toEqual({ kind: "advanced" })
    })

    test("probe s236 H: a previous cycle's crashed dispatch never completes a restarted enrolment", async () => {
      // Cycle 1 crashed after its LAST step (step 1); the enrolment was then
      // restarted at step 0 (enrolledAt = now, nothing live: no inbox), 3 min
      // after that dispatch - inside the 5-min clock tolerance.
      const s = await seed({
        stepCount: 2,
        atStep: 1,
        completedAt: new Date(Date.now() - 2 * MINUTE),
      })
      await db.execute(sql`
        UPDATE "SequenceDispatch" SET "createdAt" = now() - interval '3 minutes'
         WHERE id = ${s.dispatchId}`)
      await db.execute(sql`
        UPDATE "ContactOnSequence"
           SET "enrolledAt" = now(), "currentStep" = 0, "lastStepId" = NULL,
               "nextStepId" = ${s.steps[0] ?? null}
         WHERE id = ${s.enrollmentId}`)
      const retry = await advanceEnrollment({
        enrollmentId: s.enrollmentId,
        workspaceId: s.workspaceId,
        sequenceId: s.sequenceId,
        contactId: s.contactId,
        currentStep: { id: s.steps[1] ?? "", order: 1 },
        sentAt: new Date(Date.now() - 2 * MINUTE),
        scheduler: fakeScheduler(),
        afterDispatchId: s.dispatchId,
      })
      expect(retry).toBe(false)
      expect(
        (await recover(s, fakeScheduler())).kind,
        "reconcile, 15 min later",
      ).toBe("skipped")
      expect(
        (
          await listUnadvancedEnrollments({
            limit: 1000,
            now: new Date(Date.now() + 15 * MINUTE),
          })
        ).some((row) => row.id === s.enrollmentId),
      ).toBe(false)
      expect(await enrollmentOf(s.enrollmentId)).toMatchObject({
        status: "active",
        currentStep: 0,
      })
    })

    test("listing pages by id and caps the page size", async () => {
      const a = await seed()
      const b = await seed()
      const first = await listUnadvancedEnrollments({ limit: 1 })
      expect(first).toHaveLength(1)
      const all = await listUnadvancedEnrollments({ limit: 1000 })
      const ids = all.map((row) => row.id)
      expect(ids).toEqual(
        expect.arrayContaining([a.enrollmentId, b.enrollmentId]),
      )
      const after = await listUnadvancedEnrollments({
        limit: 1000,
        afterId: a.enrollmentId,
      })
      expect(after.map((row) => row.id)).not.toContain(a.enrollmentId)
      expect(after.map((row) => row.id)).toContain(b.enrollmentId)
    })
  },
)
