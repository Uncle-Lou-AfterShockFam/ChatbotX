// @vitest-environment node

/**
 * The enrolment END record (s228b, owner: the row is KEPT), against a REAL
 * Postgres.
 *
 * A removal ENDS the enrolment (status 'ended', endReason, endedAt) instead
 * of deleting it; its pending and held dispatches are canceled; a running one
 * is stopped at send time; an advance never moves an ended enrolment. An
 * ended enrolment is reactivated (API or re-subscribe) at the step it stopped
 * at, unless it ended for good (bounced, unsubscribed); the operator path
 * carries an optimistic 409. Every enrolment writer locks the enrolment
 * first, so none of them deadlock against a removal.
 *
 * Seeds run under `SET LOCAL session_replication_role = replica` and are
 * deleted afterwards. Run with
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, sql } from "@chatbotx.io/database/client"
import { advanceEnrollment } from "@chatbotx.io/sequence-scheduler"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"

// No Redis and no event bus here.
const scheduled = vi.fn()
vi.mock("@chatbotx.io/sequence-scheduler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/sequence-scheduler")>()),
  removeDispatchesFromSchedule: vi.fn().mockResolvedValue(undefined),
  rescheduleDispatches: vi.fn().mockResolvedValue(undefined),
  scheduleDispatches: (...args: unknown[]) => scheduled(...args),
}))
// The scheduler package's own (unmocked) internal calls reach Redis here.
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

const { contactSequenceService } = await import("../../src/contact-sequence")

const databaseUrl = requireRealDatabaseUrl()

/** Ids far above any snowflake a scratch database would hold (own range). */
let nextId = 9_228_200_000_000_000n
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

const DAY = 86_400_000

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
 * A sequence with `stepCount` anytime steps (orders 0..n-1, no delay), an
 * inbox + contact inbox (reactivation dispatches to it), and one ACTIVE
 * enrolment at step `atStep` with one dispatch for that step.
 */
async function seed(
  props: {
    stopOnReply?: boolean
    stepCount?: number
    atStep?: number
    dispatchStatus?: "pending" | "running"
    nextRunAt?: Date
  } = {},
): Promise<Seed> {
  const workspaceId = mintId()
  const sequenceId = mintId()
  const contactId = mintId()
  const inboxId = mintId()
  const contactInboxId = mintId()
  const enrollmentId = mintId()
  const dispatchId = mintId()
  const atStep = props.atStep ?? 0
  const nextRunAt = props.nextRunAt ?? new Date(Date.now() + DAY)
  // Real Workspace + Contact rows: a reactivation inserts a dispatch with
  // its foreign keys checked (no replica role there).
  await asReplica(sql`
    INSERT INTO "Workspace" (id, name, "ownerId")
    VALUES (${workspaceId}, 's228b', ${mintId()})`)
  seeded.Workspace?.push(workspaceId)
  await asReplica(sql`
    INSERT INTO "Contact" (id, "workspaceId") VALUES (${contactId}, ${workspaceId})`)
  seeded.Contact?.push(contactId)
  await asReplica(sql`
    INSERT INTO "Sequence" (id, name, "workspaceId", "stopOnReply")
    VALUES (${sequenceId}, ${`s228b ${sequenceId}`}, ${workspaceId},
            ${props.stopOnReply ?? false})`)
  seeded.Sequence?.push(sequenceId)
  const steps: string[] = []
  for (let order = 0; order < (props.stepCount ?? 2); order++) {
    const stepId = mintId()
    await asReplica(sql`
      INSERT INTO "SequenceStep" (id, "sequenceId", "order", "delayDays", anytime)
      VALUES (${stepId}, ${sequenceId}, ${order}, 0, true)`)
    seeded.SequenceStep?.push(stepId)
    steps.push(stepId)
  }
  await asReplica(sql`
    INSERT INTO "Inbox" (id, "workspaceId", name, channel, "sourceId")
    VALUES (${inboxId}, ${workspaceId}, 's228b', 'api', ${`s228b-${inboxId}`})`)
  seeded.Inbox?.push(inboxId)
  await asReplica(sql`
    INSERT INTO "ContactInbox"
      (id, "contactId", "inboxId", "originalContactId", channel, source, "sourceId")
    VALUES (${contactInboxId}, ${contactId}, ${inboxId}, ${contactId}, 'api',
            'api', ${`s228b-${contactInboxId}`})`)
  seeded.ContactInbox?.push(contactInboxId)
  await asReplica(sql`
    INSERT INTO "ContactOnSequence"
      (id, "contactId", "sequenceId", "workspaceId", status, "currentStep",
       "nextStepId", "nextRunAt", "enrolledAt")
    VALUES (${enrollmentId}, ${contactId}, ${sequenceId}, ${workspaceId},
            'active', ${atStep}, ${steps[atStep] ?? null},
            ${nextRunAt.toISOString()}, now() - interval '1 hour')`)
  seeded.ContactOnSequence?.push(enrollmentId)
  await asReplica(sql`
    INSERT INTO "SequenceDispatch"
      (id, "runAtMs", "idempotencyKey", "workspaceId", "sequenceId",
       "contactId", "contactInboxId", "stepId", "enrollmentId", status)
    VALUES (${dispatchId}, ${nextRunAt.getTime()}, ${`s228b-${dispatchId}`},
            ${workspaceId}, ${sequenceId}, ${contactId}, ${contactInboxId},
            ${steps[atStep] ?? null}, ${enrollmentId},
            ${props.dispatchStatus ?? "pending"})`)
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
  // Dispatches a reactivation created are not in `seeded`: clear by sequence.
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
  if (!databaseUrl) {
    return
  }
  await db.$client.end()
})

const TIMESTAMPS = ["endedAt", "updatedAt", "enrolledAt", "completedAt"]

/** The row, its timestamps as Dates (a raw execute returns strings). */
async function enrolment(id: string) {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT * FROM "ContactOnSequence" WHERE id = ${id}`)
  const row = result.rows[0]
  if (!row) {
    return row
  }
  for (const key of TIMESTAMPS) {
    if (row[key] !== null && row[key] !== undefined) {
      row[key] = new Date(row[key] as string)
    }
  }
  return row
}

async function dispatches(enrollmentId: string) {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT id, status, "stepId", "runAtMs", "lastError"
      FROM "SequenceDispatch" WHERE "enrollmentId" = ${enrollmentId}
     ORDER BY id`)
  return result.rows
}

const end = (
  s: Seed,
  reason: "subscription_removed" | "bounced" = "subscription_removed",
) =>
  contactSequenceService.removeContactSequencesForContacts({
    workspaceId: s.workspaceId,
    contactIds: [s.contactId],
    sequenceIds: [s.sequenceId],
    reason,
  })

describe.skipIf(!databaseUrl)("a removal ENDS the enrolment", () => {
  test("the row stays: status ended, reason, instant; the pending dispatch is canceled with the reason", async () => {
    const s = await seed()
    const before = Date.now()
    const canceled = await end(s)
    expect(canceled).toEqual([expect.objectContaining({ id: s.dispatchId })])
    const row = await enrolment(s.enrollmentId)
    expect(row).toMatchObject({
      status: "ended",
      endReason: "subscription_removed",
      currentStep: 0,
    })
    expect((row?.endedAt as Date).getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    )
    expect(await dispatches(s.enrollmentId)).toEqual([
      expect.objectContaining({
        status: "canceled",
        lastError: "subscription_removed",
      }),
    ])
  })

  test("a HELD dispatch is canceled too (it used to cascade away)", async () => {
    const s = await seed({ dispatchStatus: "running" })
    expect(
      await contactSequenceService.holdEnrollment({
        dispatchId: s.dispatchId,
        workspaceId: s.workspaceId,
        reason: "missing: first_name",
      }),
    ).toBe(true)
    await end(s)
    expect((await dispatches(s.enrollmentId))[0]).toMatchObject({
      status: "canceled",
    })
    expect((await enrolment(s.enrollmentId))?.status).toBe("ended")
  })

  test("a second removal leaves the first end untouched (reason and instant)", async () => {
    const s = await seed()
    await end(s)
    const first = await enrolment(s.enrollmentId)
    expect(
      await contactSequenceService.removeContactSequencesForContacts({
        workspaceId: s.workspaceId,
        contactIds: [s.contactId],
        sequenceIds: [s.sequenceId],
        reason: "company_stopped",
      }),
    ).toEqual([])
    const second = await enrolment(s.enrollmentId)
    expect(second?.endReason).toBe("subscription_removed")
    expect(second?.endedAt).toEqual(first?.endedAt)
  })

  test("a RUNNING dispatch of an ended enrolment is canceled at the send gate, never sent", async () => {
    const s = await seed({ dispatchStatus: "running" })
    await end(s)
    expect(
      await contactSequenceService.deferIfPaused({
        dispatchId: s.dispatchId,
        workspaceId: s.workspaceId,
      }),
    ).toBe("ended")
    expect((await dispatches(s.enrollmentId))[0]).toMatchObject({
      status: "canceled",
      lastError: "subscription_removed",
    })
  })

  test("an advance after the end moves nothing and creates no dispatch", async () => {
    const s = await seed({ dispatchStatus: "running" })
    await end(s)
    const addToSchedule = vi.fn()
    await advanceEnrollment({
      enrollmentId: s.enrollmentId,
      workspaceId: s.workspaceId,
      sequenceId: s.sequenceId,
      contactId: s.contactId,
      currentStep: { id: s.steps[0] as string, order: 0 },
      sentAt: new Date(),
      scheduler: { addToSchedule } as never,
    })
    expect(await enrolment(s.enrollmentId)).toMatchObject({
      status: "ended",
      currentStep: 0,
    })
    expect(await dispatches(s.enrollmentId)).toHaveLength(1)
    expect(addToSchedule).not.toHaveBeenCalled()
  })

  test("the last step completing after the end never flips it to completed", async () => {
    const s = await seed({ stepCount: 1, dispatchStatus: "running" })
    await end(s)
    await advanceEnrollment({
      enrollmentId: s.enrollmentId,
      workspaceId: s.workspaceId,
      sequenceId: s.sequenceId,
      contactId: s.contactId,
      currentStep: { id: s.steps[0] as string, order: 0 },
      sentAt: new Date(),
      scheduler: { addToSchedule: vi.fn() } as never,
    })
    expect((await enrolment(s.enrollmentId))?.status).toBe("ended")
  })

  test("listByContactId leaves ended rows out unless includeEnded; stop-on-reply skips them", async () => {
    const s = await seed({ stopOnReply: true })
    await end(s)
    expect(
      await contactSequenceService.listByContactId({
        workspaceId: s.workspaceId,
        contactId: s.contactId,
      }),
    ).toEqual([])
    expect(
      await contactSequenceService.listByContactId({
        workspaceId: s.workspaceId,
        contactId: s.contactId,
        includeEnded: true,
      }),
    ).toEqual([
      expect.objectContaining({
        sequenceId: s.sequenceId,
        status: "ended",
        endReason: "subscription_removed",
        replyState: "none",
      }),
    ])
    expect(
      await contactSequenceService.removeStopOnReplyEnrollments({
        workspaceId: s.workspaceId,
        contactId: s.contactId,
        repliedAt: new Date(),
      }),
    ).toEqual([])
    expect((await enrolment(s.enrollmentId))?.endReason).toBe(
      "subscription_removed",
    )
  })
})

describe.skipIf(!databaseUrl)("reactivating an ended enrolment", () => {
  const reactivate = async (s: Seed, expectedUpdatedAt?: Date) => {
    const row = await enrolment(s.enrollmentId)
    return contactSequenceService.reactivateEnrollment({
      workspaceId: s.workspaceId,
      contactId: s.contactId,
      sequenceId: s.sequenceId,
      expectedUpdatedAt: expectedUpdatedAt ?? (row?.updatedAt as Date),
    })
  }

  test("resumes at the step it stopped at, no earlier than its run time; the canceled dispatch is revived", async () => {
    scheduled.mockReset()
    const nextRunAt = new Date(Date.now() + 2 * DAY)
    const s = await seed({ stepCount: 3, atStep: 1, nextRunAt })
    await end(s)
    const { runAt } = await reactivate(s)
    expect(runAt?.getTime()).toBe(nextRunAt.getTime())
    expect(await enrolment(s.enrollmentId)).toMatchObject({
      status: "active",
      endReason: null,
      endedAt: null,
      currentStep: 1,
      nextStepId: s.steps[1],
    })
    expect(await dispatches(s.enrollmentId)).toEqual([
      expect.objectContaining({
        id: s.dispatchId,
        status: "pending",
        stepId: s.steps[1],
        runAtMs: String(nextRunAt.getTime()),
        lastError: null,
      }),
    ])
    expect(scheduled).toHaveBeenCalledWith([
      expect.objectContaining({ id: s.dispatchId }),
    ])
  })

  test("a step the enrolment already COMPLETED is never sent again: the next one runs", async () => {
    const s = await seed({ stepCount: 3, atStep: 1, dispatchStatus: "running" })
    await end(s)
    // The running step went out after all (it passed the gate first).
    await db.execute(
      sql`UPDATE "SequenceDispatch" SET status = 'completed' WHERE id = ${s.dispatchId}`,
    )
    await reactivate(s)
    const rows = await dispatches(s.enrollmentId)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ status: "pending", stepId: s.steps[2] })
    expect((await enrolment(s.enrollmentId))?.currentStep).toBe(2)
  })

  test("a contact that had finished starts over from the first step", async () => {
    const s = await seed({ stepCount: 1, dispatchStatus: "running" })
    await db.execute(
      sql`UPDATE "SequenceDispatch" SET status = 'completed' WHERE id = ${s.dispatchId}`,
    )
    await db.execute(
      sql`UPDATE "ContactOnSequence" SET status = 'completed', "completedAt" = now(), "currentStep" = 1 WHERE id = ${s.enrollmentId}`,
    )
    await end(s)
    const before = Date.now()
    await reactivate(s)
    const row = await enrolment(s.enrollmentId)
    expect(row).toMatchObject({
      status: "active",
      currentStep: 0,
      completedAt: null,
      lastStepId: null,
    })
    expect((row?.enrolledAt as Date).getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    )
    const rows = await dispatches(s.enrollmentId)
    expect(rows.at(-1)).toMatchObject({
      status: "pending",
      stepId: s.steps[0],
    })
  })

  test("skeptic s228b: a reactivate while a step is still RUNNING undoes the end and keeps that step - no second dispatch, sent once", async () => {
    const s = await seed({ stepCount: 2, atStep: 0, dispatchStatus: "running" })
    await end(s)
    const { runAt } = await reactivate(s)
    expect(runAt).toBeNull()
    expect((await enrolment(s.enrollmentId))?.status).toBe("active")
    expect(await dispatches(s.enrollmentId)).toEqual([
      expect.objectContaining({ id: s.dispatchId, status: "running" }),
    ])
    // The worker reaches its send gate: the enrolment is active, it sends.
    expect(
      await contactSequenceService.deferIfPaused({
        dispatchId: s.dispatchId,
        workspaceId: s.workspaceId,
      }),
    ).toBeNull()
  })

  test("probe s228b F2: a step resumed after its predecessor was sent still waits its own delay", async () => {
    const s = await seed({ stepCount: 2, atStep: 0, dispatchStatus: "running" })
    await db.execute(
      sql`UPDATE "SequenceStep" SET "delayDays" = 3 WHERE id = ${s.steps[1] as string}`,
    )
    await end(s)
    // The in-flight step 0 went out after all; the end stopped the advance.
    const sentAt = new Date()
    await db.execute(
      sql`UPDATE "SequenceDispatch" SET status = 'completed', "completedAt" = ${sentAt.toISOString()} WHERE id = ${s.dispatchId}`,
    )
    const { runAt } = await reactivate(s)
    expect(runAt?.getTime()).toBeGreaterThanOrEqual(sentAt.getTime() + 3 * DAY)
    expect((await enrolment(s.enrollmentId))?.currentStep).toBe(1)
  })

  test("the gate never sends a dispatch that is no longer running", async () => {
    const s = await seed({ dispatchStatus: "running" })
    await db.execute(
      sql`UPDATE "SequenceDispatch" SET status = 'canceled' WHERE id = ${s.dispatchId}`,
    )
    expect(
      await contactSequenceService.deferIfPaused({
        dispatchId: s.dispatchId,
        workspaceId: s.workspaceId,
      }),
    ).toBe("ended")
    expect(
      await contactSequenceService.deferIfPaused({
        dispatchId: mintId(),
        workspaceId: s.workspaceId,
      }),
    ).toBe("ended")
  })

  test("a stale expectedUpdatedAt is a 409 enrollmentChanged; nothing changes", async () => {
    const s = await seed()
    await end(s)
    await expect(
      reactivate(s, new Date("2020-01-01T00:00:00Z")),
    ).rejects.toMatchObject({ httpStatusCode: 409, code: "enrollmentChanged" })
    expect((await enrolment(s.enrollmentId))?.status).toBe("ended")
  })

  test("bounced or unsubscribed ends are final: 409 notReactivatable, and a re-subscribe skips them", async () => {
    const s = await seed()
    await end(s, "bounced")
    await expect(reactivate(s)).rejects.toMatchObject({
      httpStatusCode: 409,
      code: "notReactivatable",
    })
    await contactSequenceService.subscribeContacts({
      workspaceId: s.workspaceId,
      contactIds: [s.contactId],
      sequenceIds: [s.sequenceId],
    })
    expect(await enrolment(s.enrollmentId)).toMatchObject({
      status: "ended",
      endReason: "bounced",
    })
  })

  test("not ended is a 409; not enrolled is a 404; bad input is a 422", async () => {
    const s = await seed()
    await expect(reactivate(s)).rejects.toMatchObject({
      httpStatusCode: 409,
      code: "notReactivatable",
    })
    await expect(
      contactSequenceService.reactivateEnrollment({
        workspaceId: s.workspaceId,
        contactId: mintId(),
        sequenceId: s.sequenceId,
        expectedUpdatedAt: new Date(),
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    await expect(
      contactSequenceService.reactivateEnrollment({
        workspaceId: mintId(),
        contactId: s.contactId,
        sequenceId: s.sequenceId,
        expectedUpdatedAt: new Date(),
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    await expect(
      contactSequenceService.reactivateEnrollment({
        workspaceId: "x",
        contactId: s.contactId,
        sequenceId: s.sequenceId,
        expectedUpdatedAt: new Date(),
      }),
    ).rejects.toMatchObject({ httpStatusCode: 422 })
    await expect(
      contactSequenceService.reactivateEnrollment({
        workspaceId: s.workspaceId,
        contactId: s.contactId,
        sequenceId: s.sequenceId,
        expectedUpdatedAt: new Date("nope"),
      }),
    ).rejects.toMatchObject({ httpStatusCode: 422 })
    await expect(
      contactSequenceService.reactivateEnrollment(null as never),
    ).rejects.toThrow(TypeError)
  })

  test("a re-subscribe (API/bulk) reactivates the same row, never a second one", async () => {
    const s = await seed({ stepCount: 2, atStep: 1 })
    await end(s)
    await contactSequenceService.subscribeContacts({
      workspaceId: s.workspaceId,
      contactIds: [s.contactId],
      sequenceIds: [s.sequenceId],
    })
    const rows = await db.execute(sql`
      SELECT id, status, "currentStep" FROM "ContactOnSequence"
       WHERE "contactId" = ${s.contactId} AND "sequenceId" = ${s.sequenceId}`)
    expect(rows.rows).toEqual([
      { id: s.enrollmentId, status: "active", currentStep: 1 },
    ])
  })

  test("two concurrent reactivates: one wins, the other gets a 409; one pending dispatch", async () => {
    for (let i = 0; i < 5; i++) {
      const s = await seed()
      await end(s)
      const row = await enrolment(s.enrollmentId)
      const results = await Promise.allSettled([
        reactivate(s, row?.updatedAt as Date),
        reactivate(s, row?.updatedAt as Date),
      ])
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
      const pending = await db.execute(sql`
        SELECT id FROM "SequenceDispatch"
         WHERE "enrollmentId" = ${s.enrollmentId} AND status = 'pending'`)
      expect(pending.rows).toHaveLength(1)
    }
  })
})

describe.skipIf(!databaseUrl)("probe s228b regressions", () => {
  test("V2/V3: a reactivate landing between a step's completion and its advance leaves ONE pending next step (with or without a pause)", async () => {
    for (const paused of [false, true]) {
      const s = await seed({
        stepCount: 3,
        atStep: 0,
        dispatchStatus: "running",
      })
      if (paused) {
        await db.execute(
          sql`UPDATE "ContactOnSequence" SET "pausedUntil" = now() + interval '3 days' WHERE id = ${s.enrollmentId}`,
        )
      }
      await end(s, "subscription_removed")
      await db.execute(
        sql`UPDATE "SequenceDispatch" SET status = 'completed', "completedAt" = now() WHERE id = ${s.dispatchId}`,
      )
      await contactSequenceService.reactivateEnrollment({
        workspaceId: s.workspaceId,
        contactId: s.contactId,
        sequenceId: s.sequenceId,
        expectedUpdatedAt: (await enrolment(s.enrollmentId))?.updatedAt as Date,
      })
      await advanceEnrollment({
        enrollmentId: s.enrollmentId,
        workspaceId: s.workspaceId,
        sequenceId: s.sequenceId,
        contactId: s.contactId,
        currentStep: { id: s.steps[0] as string, order: 0 },
        sentAt: new Date(),
        scheduler: { addToSchedule: vi.fn() } as never,
      })
      const pending = (await dispatches(s.enrollmentId)).filter(
        (d) => d.status === "pending",
      )
      expect(pending).toEqual([expect.objectContaining({ stepId: s.steps[1] })])
    }
  })

  test("V4: a restarted cycle's sent step is never sent again after another end + re-subscribe", async () => {
    const s = await seed({ stepCount: 1, dispatchStatus: "running" })
    await db.execute(
      sql`UPDATE "SequenceDispatch" SET status = 'completed', "completedAt" = now() WHERE id = ${s.dispatchId}`,
    )
    await db.execute(
      sql`UPDATE "ContactOnSequence" SET status = 'completed', "completedAt" = now(), "currentStep" = 1 WHERE id = ${s.enrollmentId}`,
    )
    await end(s)
    // Restart: a new step 0 dispatch in the SAME transaction as enrolledAt.
    await contactSequenceService.subscribeFromFlow({
      workspaceId: s.workspaceId,
      contactId: s.contactId,
      sequenceId: s.sequenceId,
      contactInboxId: s.contactInboxId,
    })
    const restarted = (await dispatches(s.enrollmentId)).find(
      (d) => d.status === "pending",
    )
    expect(restarted).toBeDefined()
    // It runs, an end lands mid-send, it completes anyway.
    await db.execute(
      sql`UPDATE "SequenceDispatch" SET status = 'running' WHERE id = ${restarted?.id as string}`,
    )
    await end(s)
    await db.execute(
      sql`UPDATE "SequenceDispatch" SET status = 'completed', "completedAt" = now() WHERE id = ${restarted?.id as string}`,
    )
    await contactSequenceService.subscribeFromFlow({
      workspaceId: s.workspaceId,
      contactId: s.contactId,
      sequenceId: s.sequenceId,
      contactInboxId: s.contactInboxId,
    })
    // It had finished this cycle: a NEW cycle, not a resend inside it.
    const after = await enrolment(s.enrollmentId)
    expect(after?.status).toBe("active")
    expect(
      (await dispatches(s.enrollmentId)).filter((d) => d.status === "pending"),
    ).toHaveLength(1)
  })

  test("V5: a bounce after an earlier end overwrites it (keeping the first instant); never reactivated", async () => {
    const s = await seed()
    await contactSequenceService.removeContactSequencesForContacts({
      workspaceId: s.workspaceId,
      contactIds: [s.contactId],
      sequenceIds: [s.sequenceId],
      reason: "contact_replied",
    })
    const first = await enrolment(s.enrollmentId)
    await end(s, "bounced")
    const after = await enrolment(s.enrollmentId)
    expect(after?.endReason).toBe("bounced")
    expect(after?.endedAt).toEqual(first?.endedAt)
    await contactSequenceService.subscribeFromFlow({
      workspaceId: s.workspaceId,
      contactId: s.contactId,
      sequenceId: s.sequenceId,
      contactInboxId: s.contactInboxId,
    })
    expect((await enrolment(s.enrollmentId))?.status).toBe("ended")
  })

  test("F3: a stop-on-reply end records the reply (replyState replied, repliedAt)", async () => {
    const s = await seed({ stopOnReply: true })
    const repliedAt = new Date()
    await contactSequenceService.removeStopOnReplyEnrollments({
      workspaceId: s.workspaceId,
      contactId: s.contactId,
      repliedAt,
    })
    const row = await enrolment(s.enrollmentId)
    expect(row).toMatchObject({
      status: "ended",
      endReason: "contact_replied",
      replyState: "replied",
    })
    expect(new Date(row?.repliedAt as string).getTime()).toBe(
      repliedAt.getTime(),
    )
  })

  test("F4: a flow step never enrols into another workspace's sequence", async () => {
    const s = await seed()
    await expect(
      contactSequenceService.subscribeFromFlow({
        workspaceId: mintId(),
        contactId: s.contactId,
        sequenceId: s.sequenceId,
        contactInboxId: s.contactInboxId,
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
  })
})

describe.skipIf(!databaseUrl)(
  "no deadlock against a removal (40 runs each)",
  () => {
    const DEADLOCK = "40P01"
    const deadlocked = (results: PromiseSettledResult<unknown>[]) =>
      results.filter(
        (r) =>
          r.status === "rejected" &&
          JSON.stringify(
            r.reason,
            Object.getOwnPropertyNames(r.reason),
          ).includes(DEADLOCK),
      ).length

    test("the out-of-office pause (it now locks the enrolment first)", async () => {
      let deadlocks = 0
      for (let i = 0; i < 40; i++) {
        const s = await seed({ stopOnReply: true })
        deadlocks += deadlocked(
          await Promise.allSettled([
            contactSequenceService.pauseForAutoReply({
              workspaceId: s.workspaceId,
              contactId: s.contactId,
              occurredAt: new Date(),
            }),
            end(s),
          ]),
        )
        expect((await enrolment(s.enrollmentId))?.status).toBe("ended")
        expect(
          (await dispatches(s.enrollmentId)).every(
            (d) => d.status === "canceled",
          ),
        ).toBe(true)
      }
      expect(deadlocks).toBe(0)
    })

    test("V1: a pause-defer at the send gate racing a removal never leaves an ended enrolment with a pending step", async () => {
      let deadlocks = 0
      for (let i = 0; i < 40; i++) {
        const s = await seed({ dispatchStatus: "running" })
        await db.execute(
          sql`UPDATE "ContactOnSequence" SET "pausedUntil" = now() + interval '7 days' WHERE id = ${s.enrollmentId}`,
        )
        deadlocks += deadlocked(
          await Promise.allSettled([
            contactSequenceService.deferIfPaused({
              dispatchId: s.dispatchId,
              workspaceId: s.workspaceId,
            }),
            end(s),
          ]),
        )
        expect((await enrolment(s.enrollmentId))?.status).toBe("ended")
        expect((await dispatches(s.enrollmentId))[0]?.status).toBe("canceled")
      }
      expect(deadlocks).toBe(0)
    })

    test("a reactivate racing a removal ends in one consistent state", async () => {
      let deadlocks = 0
      for (let i = 0; i < 40; i++) {
        const s = await seed()
        await end(s)
        const row = await enrolment(s.enrollmentId)
        deadlocks += deadlocked(
          await Promise.allSettled([
            contactSequenceService.reactivateEnrollment({
              workspaceId: s.workspaceId,
              contactId: s.contactId,
              sequenceId: s.sequenceId,
              expectedUpdatedAt: row?.updatedAt as Date,
            }),
            end(s),
          ]),
        )
        const after = await enrolment(s.enrollmentId)
        const pending = (await dispatches(s.enrollmentId)).filter(
          (d) => d.status === "pending",
        )
        // Active with exactly one pending step, or ended with none.
        expect(pending).toHaveLength(after?.status === "active" ? 1 : 0)
      }
      expect(deadlocks).toBe(0)
    })

    test("the send gate racing a removal: a running step is either canceled or left to send, never orphaned pending", async () => {
      let deadlocks = 0
      for (let i = 0; i < 40; i++) {
        const s = await seed({ dispatchStatus: "running" })
        deadlocks += deadlocked(
          await Promise.allSettled([
            contactSequenceService.deferIfPaused({
              dispatchId: s.dispatchId,
              workspaceId: s.workspaceId,
            }),
            end(s),
          ]),
        )
        expect((await dispatches(s.enrollmentId))[0]?.status).not.toBe(
          "pending",
        )
      }
      expect(deadlocks).toBe(0)
    })
  },
)

describe.skipIf(!databaseUrl)(
  "endOutreach (s228b PR 2): a bounce or an unsubscribe",
  () => {
    test("a bounce ends the contact's outreach (stop-on-reply) enrolments for good, with the reply state; others are untouched", async () => {
      const outreach = await seed({ stopOnReply: true })
      const other = await seed({ stopOnReply: false })
      const at = new Date()
      expect(
        await contactSequenceService.endOutreach({
          workspaceId: outreach.workspaceId,
          contactId: outreach.contactId,
          reason: "bounced",
          at,
        }),
      ).toEqual([outreach.sequenceId])
      expect(await enrolment(outreach.enrollmentId)).toMatchObject({
        status: "ended",
        endReason: "bounced",
        replyState: "bounced",
      })
      expect(await enrolment(other.enrollmentId)).toMatchObject({
        status: "active",
      })
      await expect(
        contactSequenceService.reactivateEnrollment({
          workspaceId: outreach.workspaceId,
          contactId: outreach.contactId,
          sequenceId: outreach.sequenceId,
          expectedUpdatedAt: (await enrolment(outreach.enrollmentId))
            ?.updatedAt as Date,
        }),
      ).rejects.toMatchObject({ code: "notReactivatable" })
    })

    test("an unsubscribe overwrites an earlier reply end; the reply state stays", async () => {
      const s = await seed({ stopOnReply: true })
      await contactSequenceService.removeStopOnReplyEnrollments({
        workspaceId: s.workspaceId,
        contactId: s.contactId,
        repliedAt: new Date(),
      })
      await contactSequenceService.endOutreach({
        workspaceId: s.workspaceId,
        contactId: s.contactId,
        reason: "unsubscribed",
      })
      expect(await enrolment(s.enrollmentId)).toMatchObject({
        status: "ended",
        endReason: "unsubscribed",
        replyState: "replied",
      })
    })

    test("an out-of-office pause records replyState ooo", async () => {
      const s = await seed({ stopOnReply: true })
      await contactSequenceService.pauseForAutoReply({
        workspaceId: s.workspaceId,
        contactId: s.contactId,
        occurredAt: new Date(),
      })
      expect(await enrolment(s.enrollmentId)).toMatchObject({
        status: "active",
        replyState: "ooo",
      })
    })

    test("bad input is refused before any query", async () => {
      await expect(
        contactSequenceService.endOutreach(null as never),
      ).rejects.toThrow(TypeError)
      await expect(
        contactSequenceService.endOutreach({
          workspaceId: "x",
          contactId: "1",
          reason: "bounced",
        }),
      ).rejects.toMatchObject({ httpStatusCode: 422 })
      await expect(
        contactSequenceService.endOutreach({
          workspaceId: "1",
          contactId: "1",
          reason: "replied" as never,
        }),
      ).rejects.toThrow(TypeError)
    })
  },
)

describe.skipIf(!databaseUrl)(
  "endOutreach history (skeptic s228b PR 2)",
  () => {
    test("a bounce never rewrites a completed enrolment, and keeps an earlier end's reply state", async () => {
      const live = await seed({ stopOnReply: true })
      const done = await seed({ stopOnReply: true })
      const replied = await seed({ stopOnReply: true })
      // One contact across the three sequences.
      for (const other of [done, replied]) {
        await db.execute(
          sql`UPDATE "ContactOnSequence" SET "contactId" = ${live.contactId}, "workspaceId" = ${live.workspaceId} WHERE id = ${other.enrollmentId}`,
        )
        await db.execute(
          sql`UPDATE "Sequence" SET "workspaceId" = ${live.workspaceId} WHERE id = ${other.sequenceId}`,
        )
        await db.execute(
          sql`UPDATE "SequenceDispatch" SET "workspaceId" = ${live.workspaceId}, "contactId" = ${live.contactId} WHERE id = ${other.dispatchId}`,
        )
      }
      await db.execute(
        sql`UPDATE "ContactOnSequence" SET status = 'completed', "completedAt" = now() WHERE id = ${done.enrollmentId}`,
      )
      await db.execute(
        sql`UPDATE "ContactOnSequence" SET status = 'ended', "endReason" = 'contact_replied', "endedAt" = now(), "replyState" = 'replied', "repliedAt" = now() WHERE id = ${replied.enrollmentId}`,
      )
      await contactSequenceService.endOutreach({
        workspaceId: live.workspaceId,
        contactId: live.contactId,
        reason: "bounced",
      })
      expect(await enrolment(live.enrollmentId)).toMatchObject({
        status: "ended",
        endReason: "bounced",
        replyState: "bounced",
      })
      expect(await enrolment(done.enrollmentId)).toMatchObject({
        status: "completed",
        endReason: null,
        replyState: "none",
      })
      expect(await enrolment(replied.enrollmentId)).toMatchObject({
        status: "ended",
        endReason: "bounced",
        replyState: "replied",
      })
    })
  },
)

/**
 * s236: what an email-line send reads to gate a queued mail on a reply
 * (worker send-email-reply-gate.ts). These are the code facts its
 * T = nextWholeMinute(max(enrolledAt, repliedAt)) rests on.
 */
describe.skipIf(!databaseUrl)(
  "s236 findReplyGate: the cycle a line mail gates on",
  () => {
    const gate = (s: Seed) =>
      contactSequenceService.findReplyGate({
        dispatchId: s.dispatchId,
        workspaceId: s.workspaceId,
      })
    const reactivate = async (s: Seed) => {
      const row = await enrolment(s.enrollmentId)
      return contactSequenceService.reactivateEnrollment({
        workspaceId: s.workspaceId,
        contactId: s.contactId,
        sequenceId: s.sequenceId,
        expectedUpdatedAt: row?.updatedAt as Date,
      })
    }

    test("an active first cycle: the stop rule, the enrolment instant, no answer yet", async () => {
      const s = await seed({ stopOnReply: true })
      const row = await enrolment(s.enrollmentId)
      expect(await gate(s)).toEqual({
        stopOnReply: true,
        status: "active",
        enrolledAt: row?.enrolledAt,
        repliedAt: null,
      })
    })

    test("a reply end keeps enrolledAt and stamps repliedAt; a resuming reactivation keeps BOTH (so T must step past the reply)", async () => {
      const s = await seed({ stopOnReply: true, stepCount: 3, atStep: 1 })
      const enrolledAt = (await enrolment(s.enrollmentId))?.enrolledAt as Date
      const repliedAt = new Date(Date.now() - 60_000)
      await contactSequenceService.removeStopOnReplyEnrollments({
        workspaceId: s.workspaceId,
        contactId: s.contactId,
        repliedAt,
      })
      expect(await gate(s)).toEqual({
        stopOnReply: true,
        status: "ended",
        enrolledAt,
        repliedAt,
      })
      await reactivate(s)
      const after = await gate(s)
      expect(after).toEqual({
        stopOnReply: true,
        status: "active",
        enrolledAt,
        repliedAt,
      })
      expect(after?.repliedAt?.getTime()).toBeGreaterThan(enrolledAt.getTime())
    })

    test("a restart of a contact that had finished resets enrolledAt past the old reply", async () => {
      const s = await seed({ stopOnReply: true, stepCount: 1, atStep: 0 })
      await db.execute(
        sql`UPDATE "SequenceDispatch" SET status = 'completed', "completedAt" = now() WHERE id = ${s.dispatchId}`,
      )
      const repliedAt = new Date(Date.now() - 60_000)
      await contactSequenceService.removeStopOnReplyEnrollments({
        workspaceId: s.workspaceId,
        contactId: s.contactId,
        repliedAt,
      })
      await reactivate(s)
      const after = await gate(s)
      expect(after).toMatchObject({ status: "active", repliedAt })
      expect(after?.enrolledAt.getTime()).toBeGreaterThan(repliedAt.getTime())
    })

    test("stopOnReply off is reported as off; another workspace, a missing or malformed id is null", async () => {
      const s = await seed({ stopOnReply: false })
      expect(await gate(s)).toMatchObject({ stopOnReply: false })
      expect(
        await contactSequenceService.findReplyGate({
          dispatchId: s.dispatchId,
          workspaceId: mintId(),
        }),
      ).toBeNull()
      for (const dispatchId of [mintId(), "", "d-1", "1".repeat(20)]) {
        expect(
          await contactSequenceService.findReplyGate({
            dispatchId,
            workspaceId: s.workspaceId,
          }),
        ).toBeNull()
      }
      expect(
        await contactSequenceService.findReplyGate(null as never),
      ).toBeNull()
    })
  },
)
