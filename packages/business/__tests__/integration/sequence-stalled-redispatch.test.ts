// @vitest-environment node

/**
 * s235: a STALLED enrolment (active, due, no dispatch for its next step) is
 * re-dispatched by the reconcile pass, against a REAL Postgres.
 *
 * Only a finished dispatch advances an enrolment, so when the next step's
 * dispatch row is cascaded away (a deleted step, a deleted inbox) or never
 * made, the enrolment used to stay "active" forever. The re-dispatch locks
 * the enrolment first, re-checks the stall under the lock, and creates ONE
 * dispatch on the contact's most recently active inbox; a failed or canceled
 * step is never re-sent.
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, sql } from "@chatbotx.io/database/client"
import {
  listStalledEnrollments,
  redispatchStalledEnrollment,
  STALLED_ENROLLMENT_GRACE_MS,
} from "@chatbotx.io/sequence-scheduler"
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
let nextId = 9_235_500_000_000_000n
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

type Seed = {
  workspaceId: string
  sequenceId: string
  contactId: string
  inboxes: { inboxId: string; contactInboxId: string }[]
  steps: string[]
  enrollmentId: string
  dispatchId: string | null
}

/**
 * A sequence with `stepCount` anytime steps, `inboxCount` inboxes the contact
 * is on (the LAST one is the most recently active), and one ACTIVE enrolment
 * at step `atStep` due at `nextRunAt`, with a pending dispatch for that step
 * on the first inbox unless `dispatch` is false or a terminal status.
 */
async function seed(
  props: {
    stepCount?: number
    atStep?: number
    inboxCount?: number
    nextRunAt?: Date
    dispatch?: false | "pending" | "failed" | "canceled"
    pausedUntil?: Date
  } = {},
): Promise<Seed> {
  const workspaceId = mintId()
  const sequenceId = mintId()
  const contactId = mintId()
  const enrollmentId = mintId()
  const atStep = props.atStep ?? 0
  const nextRunAt = props.nextRunAt ?? new Date(Date.now() - 30 * MINUTE)
  await asReplica(sql`
    INSERT INTO "Workspace" (id, name, "ownerId")
    VALUES (${workspaceId}, 's235 stall', ${mintId()})`)
  seeded.Workspace?.push(workspaceId)
  await asReplica(sql`
    INSERT INTO "Contact" (id, "workspaceId") VALUES (${contactId}, ${workspaceId})`)
  seeded.Contact?.push(contactId)
  await asReplica(sql`
    INSERT INTO "Sequence" (id, name, "workspaceId")
    VALUES (${sequenceId}, ${`s235 ${sequenceId}`}, ${workspaceId})`)
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
  const inboxes: Seed["inboxes"] = []
  for (let index = 0; index < (props.inboxCount ?? 2); index++) {
    const inboxId = mintId()
    const contactInboxId = mintId()
    await asReplica(sql`
      INSERT INTO "Inbox" (id, "workspaceId", name, channel, "sourceId")
      VALUES (${inboxId}, ${workspaceId}, 's235', 'api', ${`s235-${inboxId}`})`)
    seeded.Inbox?.push(inboxId)
    await asReplica(sql`
      INSERT INTO "ContactInbox"
        (id, "contactId", "inboxId", "originalContactId", channel, source,
         "sourceId", "lastIncomingMessageAt")
      VALUES (${contactInboxId}, ${contactId}, ${inboxId}, ${contactId}, 'api',
              'api', ${`s235-${contactInboxId}`},
              now() - ${`${10 - index} minutes`}::interval)`)
    seeded.ContactInbox?.push(contactInboxId)
    inboxes.push({ inboxId, contactInboxId })
  }
  await asReplica(sql`
    INSERT INTO "ContactOnSequence"
      (id, "contactId", "sequenceId", "workspaceId", status, "currentStep",
       "nextStepId", "nextRunAt", "enrolledAt", "pausedUntil")
    VALUES (${enrollmentId}, ${contactId}, ${sequenceId}, ${workspaceId},
            'active', ${atStep}, ${steps[atStep] ?? null},
            ${nextRunAt.toISOString()}, now() - interval '2 hours',
            ${props.pausedUntil?.toISOString() ?? null})`)
  seeded.ContactOnSequence?.push(enrollmentId)
  let dispatchId: string | null = null
  if (props.dispatch !== false) {
    dispatchId = mintId()
    await asReplica(sql`
      INSERT INTO "SequenceDispatch"
        (id, "runAtMs", "idempotencyKey", "workspaceId", "sequenceId",
         "contactId", "contactInboxId", "stepId", "enrollmentId", status)
      VALUES (${dispatchId}, ${nextRunAt.getTime()}, ${`s235-${dispatchId}`},
              ${workspaceId}, ${sequenceId}, ${contactId},
              ${inboxes[0]?.contactInboxId ?? null}, ${steps[atStep] ?? null},
              ${enrollmentId}, ${props.dispatch ?? "pending"})`)
    seeded.SequenceDispatch?.push(dispatchId)
  }
  return {
    workspaceId,
    sequenceId,
    contactId,
    inboxes,
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

const liveDispatches = async (enrollmentId: string) =>
  (
    await db.execute<{
      id: string
      stepId: string
      contactInboxId: string
      status: string
    }>(sql`
      SELECT id::text, "stepId"::text AS "stepId",
             "contactInboxId"::text AS "contactInboxId", status
        FROM "SequenceDispatch"
       WHERE "enrollmentId" = ${enrollmentId}
         AND status IN ('pending', 'running', 'held')`)
  ).rows

const isListed = async (s: Seed) =>
  (await listStalledEnrollments({ limit: 1000 })).some(
    (row) => row.id === s.enrollmentId,
  )

describe.skipIf(!databaseUrl)(
  "stalled enrolments are re-dispatched (s235)",
  () => {
    test("the dispatch's ContactInbox is deleted: the stall is found and ONE dispatch goes on the most recently active inbox left", async () => {
      const s = await seed({ inboxCount: 3 })
      // The first inbox (the dispatch's) goes away: its dispatch cascades.
      await db.execute(
        sql`DELETE FROM "ContactInbox" WHERE id = ${s.inboxes[0]?.contactInboxId ?? ""}`,
      )
      expect(await liveDispatches(s.enrollmentId)).toEqual([])
      expect(await isListed(s)).toBe(true)

      const result = await redispatchStalledEnrollment({
        workspaceId: s.workspaceId,
        enrollmentId: s.enrollmentId,
      })
      expect(result.kind).toBe("redispatched")
      const live = await liveDispatches(s.enrollmentId)
      expect(live).toHaveLength(1)
      expect(live[0]).toMatchObject({
        stepId: s.steps[0],
        // inbox index 2 wrote last
        contactInboxId: s.inboxes[2]?.contactInboxId,
        status: "pending",
      })
      // A second pass: not stalled any more, nothing new.
      expect(await isListed(s)).toBe(false)
      expect(
        await redispatchStalledEnrollment({
          workspaceId: s.workspaceId,
          enrollmentId: s.enrollmentId,
        }),
      ).toEqual({ kind: "skipped", reason: "not-stalled" })
      expect(await liveDispatches(s.enrollmentId)).toHaveLength(1)
    })

    test("deleting the enrolment's NEXT step (real service): the enrolment is re-dispatched to the step that took its place", async () => {
      const s = await seed({ stepCount: 3, atStep: 1 })
      await sequenceService.deleteStep({
        workspaceId: s.workspaceId,
        sequenceId: s.sequenceId,
        stepId: s.steps[1] ?? "",
      })
      expect(await liveDispatches(s.enrollmentId)).toEqual([])
      const [row] = (
        await db.execute<{ nextStepId: string; nextRunAt: string }>(sql`
        SELECT "nextStepId"::text AS "nextStepId", "nextRunAt"
          FROM "ContactOnSequence" WHERE id = ${s.enrollmentId}`)
      ).rows
      // The recalculation pointed the enrolment at a surviving step...
      expect(row?.nextStepId).not.toBe(s.steps[1])
      // ...with nothing to send it. Once due past the grace, it is found.
      await db.execute(sql`
      UPDATE "ContactOnSequence" SET "nextRunAt" = now() - interval '30 minutes'
       WHERE id = ${s.enrollmentId}`)
      expect(await isListed(s)).toBe(true)
      const result = await redispatchStalledEnrollment({
        workspaceId: s.workspaceId,
        enrollmentId: s.enrollmentId,
      })
      expect(result.kind).toBe("redispatched")
      const live = await liveDispatches(s.enrollmentId)
      expect(live).toHaveLength(1)
      expect(live[0]?.stepId).toBe(row?.nextStepId)
    })

    test.each([
      [
        "a FAILED dispatch for the step (never re-sent)",
        { dispatch: "failed" as const },
      ],
      [
        "a CANCELED dispatch for the step (never re-sent)",
        { dispatch: "canceled" as const },
      ],
      ["a live pending dispatch", { dispatch: "pending" as const }],
      [
        "due inside the grace window",
        {
          dispatch: false as const,
          nextRunAt: new Date(Date.now() - STALLED_ENROLLMENT_GRACE_MS / 2),
        },
      ],
      [
        "not due yet",
        {
          dispatch: false as const,
          nextRunAt: new Date(Date.now() + 60 * MINUTE),
        },
      ],
      [
        "paused (out of office)",
        {
          dispatch: false as const,
          pausedUntil: new Date(Date.now() + 60 * MINUTE),
        },
      ],
    ])("not stalled: %s", async (_label, props) => {
      const s = await seed(props)
      expect(await isListed(s)).toBe(false)
      const before = (await liveDispatches(s.enrollmentId)).length
      expect(
        await redispatchStalledEnrollment({
          workspaceId: s.workspaceId,
          enrollmentId: s.enrollmentId,
        }),
      ).toEqual({ kind: "skipped", reason: "not-stalled" })
      expect(await liveDispatches(s.enrollmentId)).toHaveLength(before)
    })

    test("an ended or completed enrolment is never re-dispatched", async () => {
      const ended = await seed({ dispatch: false })
      await db.execute(sql`
      UPDATE "ContactOnSequence" SET status = 'ended', "endReason" = 'manual', "endedAt" = now()
       WHERE id = ${ended.enrollmentId}`)
      const completed = await seed({ dispatch: false })
      await db.execute(sql`
      UPDATE "ContactOnSequence" SET status = 'completed', "completedAt" = now()
       WHERE id = ${completed.enrollmentId}`)
      expect(await isListed(ended)).toBe(false)
      expect(await isListed(completed)).toBe(false)
    })

    test("no inbox left: skipped (no-inbox), nothing written, still listed for a later pass", async () => {
      const s = await seed({ inboxCount: 1, dispatch: false })
      await db.execute(
        sql`DELETE FROM "ContactInbox" WHERE id = ${s.inboxes[0]?.contactInboxId ?? ""}`,
      )
      expect(
        await redispatchStalledEnrollment({
          workspaceId: s.workspaceId,
          enrollmentId: s.enrollmentId,
        }),
      ).toEqual({ kind: "skipped", reason: "no-inbox" })
      expect(await liveDispatches(s.enrollmentId)).toEqual([])
      expect(await isListed(s)).toBe(true)
    })

    test("8 concurrent re-dispatches (two reconcile replicas) make exactly ONE dispatch", async () => {
      for (let round = 0; round < 4; round++) {
        const s = await seed({ dispatch: false })
        const results = await Promise.all(
          Array.from({ length: 8 }, () =>
            redispatchStalledEnrollment({
              workspaceId: s.workspaceId,
              enrollmentId: s.enrollmentId,
            }),
          ),
        )
        expect(results.filter((r) => r.kind === "redispatched")).toHaveLength(1)
        expect(await liveDispatches(s.enrollmentId)).toHaveLength(1)
      }
    })

    test("another workspace's id never matches (workspace-scoped lock)", async () => {
      const s = await seed({ dispatch: false })
      const other = await seed({ dispatch: false })
      expect(
        await redispatchStalledEnrollment({
          workspaceId: other.workspaceId,
          enrollmentId: s.enrollmentId,
        }),
      ).toEqual({ kind: "skipped", reason: "not-stalled" })
      expect(await liveDispatches(s.enrollmentId)).toEqual([])
    })
  },
)
