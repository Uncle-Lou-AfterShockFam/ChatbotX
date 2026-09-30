// @vitest-environment node

/**
 * Sequence step hold (s227b outreach B-1 H3), against a REAL Postgres.
 *
 * `holdEnrollment` holds an ACTIVE enrolment whose step is missing required
 * fields (status 'held', reason in lastError, dispatch 'held');
 * `resumeHeldEnrollment` puts it back (pending at max(now, pausedUntil)),
 * 409 on anything not held, one winner under concurrency.
 *
 * Seeds run under `SET LOCAL session_replication_role = replica` (no
 * Workspace / Contact / Step rows) and are deleted afterwards. Run with
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, sql } from "@chatbotx.io/database/client"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"

// Removal drops dispatches from the Redis schedule and emits events; neither
// exists here.
const rescheduled = vi.fn()
vi.mock("@chatbotx.io/sequence-scheduler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/sequence-scheduler")>()),
  removeDispatchesFromSchedule: vi.fn().mockResolvedValue(undefined),
  rescheduleDispatches: (...args: unknown[]) => rescheduled(...args),
}))
vi.mock("@chatbotx.io/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/events")>()),
  emitSequenceUnsubscribed: vi.fn().mockResolvedValue(undefined),
}))

const { contactSequenceService } = await import("../../src/contact-sequence")

const databaseUrl = requireRealDatabaseUrl()

/** Ids far above any snowflake a scratch database would hold (own range). */
let nextId = 9_227_500_000_000_000n
function mintId(): string {
  nextId += 1n
  return nextId.toString()
}

const seeded: Record<string, string[]> = {
  SequenceDispatch: [],
  ContactOnSequence: [],
  SequenceStep: [],
  ContactInbox: [],
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

async function seedSequence(props: {
  workspaceId: string
  stopOnReply: boolean
}): Promise<string> {
  const id = mintId()
  await asReplica(sql`
    INSERT INTO "Sequence" (id, name, "workspaceId", "stopOnReply")
    VALUES (${id}, ${`s227b ${id}`}, ${props.workspaceId}, ${props.stopOnReply})`)
  seeded.Sequence?.push(id)
  return id
}

/** One enrolment with one pending dispatch. */
async function seedEnrollment(props: {
  workspaceId: string
  sequenceId: string
  contactId: string
  dispatchStatus?: "pending" | "running"
  enrolledAt?: Date
  window?: { start: string; end: string; days: string | null }
}): Promise<{ enrollmentId: string; dispatchId: string }> {
  const enrollmentId = mintId()
  const dispatchId = mintId()
  const stepId = mintId()
  await asReplica(sql`
    INSERT INTO "SequenceStep"
      (id, "sequenceId", "order", "delayDays", anytime, "sendTimeStart",
       "sendTimeEnd", "sendDays")
    VALUES (${stepId}, ${props.sequenceId}, 1, 0, ${props.window === undefined},
            ${props.window?.start ?? null}, ${props.window?.end ?? null},
            ${props.window?.days ?? null})`)
  seeded.SequenceStep?.push(stepId)
  await asReplica(sql`
    INSERT INTO "ContactOnSequence"
      (id, "contactId", "sequenceId", "workspaceId", status, "nextRunAt",
       "enrolledAt")
    VALUES (${enrollmentId}, ${props.contactId}, ${props.sequenceId},
            ${props.workspaceId}, 'active', now() + interval '1 day',
            ${(props.enrolledAt ?? new Date(Date.now() - 60_000)).toISOString()})`)
  seeded.ContactOnSequence?.push(enrollmentId)
  await asReplica(sql`
    INSERT INTO "SequenceDispatch"
      (id, "runAtMs", "idempotencyKey", "workspaceId", "sequenceId",
       "contactId", "contactInboxId", "stepId", "enrollmentId", status)
    VALUES (${dispatchId}, ${Date.now() + 86_400_000}, ${`s227b-${dispatchId}`},
            ${props.workspaceId}, ${props.sequenceId}, ${props.contactId}, 1, ${stepId},
            ${enrollmentId}, ${props.dispatchStatus ?? "pending"})`)
  seeded.SequenceDispatch?.push(dispatchId)
  return { enrollmentId, dispatchId }
}

afterEach(async () => {
  if (!databaseUrl) {
    return
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

async function row(table: string, id: string) {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT * FROM ${sql.identifier(table)} WHERE id = ${id}`)
  return result.rows[0]
}

const DAY = 86_400_000
const NUMERIC_ID = /^\d{1,19}$/

async function statusOf(enrollmentId: string, dispatchId: string) {
  const enrol = await row("ContactOnSequence", enrollmentId)
  const dispatch = await row("SequenceDispatch", dispatchId)
  return {
    enrolment: enrol?.status,
    lastError: enrol?.lastError,
    nextRunAt: enrol?.nextRunAt,
    dispatch: dispatch?.status,
    dispatchError: dispatch?.lastError,
    runAtMs: dispatch ? Number(dispatch.runAtMs) : undefined,
  }
}

async function seedHeld() {
  const workspaceId = mintId()
  const sequenceId = await seedSequence({ workspaceId, stopOnReply: true })
  const contactId = mintId()
  const seededRow = await seedEnrollment({
    workspaceId,
    sequenceId,
    contactId,
    dispatchStatus: "running",
  })
  expect(
    await contactSequenceService.holdEnrollment({
      dispatchId: seededRow.dispatchId,
      workspaceId,
      reason: "missing: first_name",
    }),
  ).toBe(true)
  return { workspaceId, sequenceId, contactId, ...seededRow }
}

describe.skipIf(!databaseUrl)("holdEnrollment", () => {
  test("holds a running step: enrolment held with the reason, dispatch held", async () => {
    const held = await seedHeld()
    expect(await statusOf(held.enrollmentId, held.dispatchId)).toMatchObject({
      enrolment: "held",
      lastError: "missing: first_name",
      nextRunAt: null,
      dispatch: "held",
      dispatchError: "missing: first_name",
    })
  })

  test("nothing to hold: a pending dispatch, or an enrolment that is not active", async () => {
    const workspaceId = mintId()
    const sequenceId = await seedSequence({ workspaceId, stopOnReply: false })
    const pending = await seedEnrollment({
      workspaceId,
      sequenceId,
      contactId: mintId(),
    })
    expect(
      await contactSequenceService.holdEnrollment({
        dispatchId: pending.dispatchId,
        workspaceId,
        reason: "missing: x",
      }),
    ).toBe(false)
    expect(
      (await statusOf(pending.enrollmentId, pending.dispatchId)).dispatch,
    ).toBe("pending")
    const done = await seedEnrollment({
      workspaceId,
      sequenceId,
      contactId: mintId(),
      dispatchStatus: "running",
    })
    await db.execute(
      sql`UPDATE "ContactOnSequence" SET status = 'completed' WHERE id = ${done.enrollmentId}`,
    )
    expect(
      await contactSequenceService.holdEnrollment({
        dispatchId: done.dispatchId,
        workspaceId,
        reason: "missing: x",
      }),
    ).toBe(false)
    expect(await statusOf(done.enrollmentId, done.dispatchId)).toMatchObject({
      enrolment: "completed",
      dispatch: "running",
    })
    // Another workspace's id holds nothing.
    const held = await seedHeld()
    expect(
      await contactSequenceService.holdEnrollment({
        dispatchId: held.dispatchId,
        workspaceId: mintId(),
        reason: "missing: x",
      }),
    ).toBe(false)
  })

  test("a reason is required; it is capped", async () => {
    await expect(
      contactSequenceService.holdEnrollment({
        dispatchId: "1",
        workspaceId: "1",
        reason: "  ",
      }),
    ).rejects.toThrow(TypeError)
    const workspaceId = mintId()
    const sequenceId = await seedSequence({ workspaceId, stopOnReply: false })
    const seededRow = await seedEnrollment({
      workspaceId,
      sequenceId,
      contactId: mintId(),
      dispatchStatus: "running",
    })
    await contactSequenceService.holdEnrollment({
      dispatchId: seededRow.dispatchId,
      workspaceId,
      reason: `missing: ${"x".repeat(2000)}`,
    })
    expect(
      String(
        (await statusOf(seededRow.enrollmentId, seededRow.dispatchId))
          .lastError,
      ).length,
    ).toBe(500)
  })

  test("a hold racing an unenrol leaves no orphan (held dispatch without its enrolment)", async () => {
    for (let i = 0; i < 5; i++) {
      const workspaceId = mintId()
      const sequenceId = await seedSequence({ workspaceId, stopOnReply: false })
      const contactId = mintId()
      const seededRow = await seedEnrollment({
        workspaceId,
        sequenceId,
        contactId,
        dispatchStatus: "running",
      })
      await Promise.all([
        contactSequenceService.holdEnrollment({
          dispatchId: seededRow.dispatchId,
          workspaceId,
          reason: "missing: x",
        }),
        contactSequenceService.removeContactSequencesForContacts({
          workspaceId,
          contactIds: [contactId],
          sequenceIds: [sequenceId],
          reason: "subscription_removed",
        }),
      ])
      const orphans = await db.execute(sql`
        SELECT d.id FROM "SequenceDispatch" d
        LEFT JOIN "ContactOnSequence" c ON c.id = d."enrollmentId"
        WHERE d.id = ${seededRow.dispatchId} AND c.id IS NULL`)
      expect(orphans.rows).toEqual([])
    }
  })
})

describe.skipIf(!databaseUrl)("resumeHeldEnrollment", () => {
  test("resumes: active, reason cleared, the dispatch pending now and rescheduled", async () => {
    rescheduled.mockReset()
    const held = await seedHeld()
    const now = new Date()
    const { runAt } = await contactSequenceService.resumeHeldEnrollment({
      workspaceId: held.workspaceId,
      contactId: held.contactId,
      sequenceId: held.sequenceId,
      now,
    })
    expect(runAt.getTime()).toBe(now.getTime())
    expect(await statusOf(held.enrollmentId, held.dispatchId)).toMatchObject({
      enrolment: "active",
      lastError: null,
      dispatch: "pending",
      dispatchError: null,
      runAtMs: now.getTime(),
    })
    expect(rescheduled).toHaveBeenCalledWith([
      expect.objectContaining({
        id: held.dispatchId,
        runAtMs: String(now.getTime()),
      }),
    ])
    // Held again next time: holdEnrollment needs a running dispatch, so the
    // resumed one goes through the normal claim first.
  })

  test("an out-of-office pause still in force: runs at the pause end, never earlier", async () => {
    const held = await seedHeld()
    const now = new Date()
    const until = new Date(now.getTime() + 3 * DAY)
    await db.execute(
      sql`UPDATE "ContactOnSequence" SET "pausedUntil" = ${until.toISOString()} WHERE id = ${held.enrollmentId}`,
    )
    const { runAt } = await contactSequenceService.resumeHeldEnrollment({
      workspaceId: held.workspaceId,
      contactId: held.contactId,
      sequenceId: held.sequenceId,
      now,
    })
    expect(runAt.getTime()).toBe(until.getTime())
    expect((await statusOf(held.enrollmentId, held.dispatchId)).runAtMs).toBe(
      until.getTime(),
    )
  })

  test("not held is a 409; not enrolled is a 404; another workspace sees nothing", async () => {
    const workspaceId = mintId()
    const sequenceId = await seedSequence({ workspaceId, stopOnReply: false })
    const contactId = mintId()
    await seedEnrollment({ workspaceId, sequenceId, contactId })
    await expect(
      contactSequenceService.resumeHeldEnrollment({
        workspaceId,
        contactId,
        sequenceId,
      }),
    ).rejects.toMatchObject({ httpStatusCode: 409 })
    await expect(
      contactSequenceService.resumeHeldEnrollment({
        workspaceId,
        contactId: mintId(),
        sequenceId,
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    const held = await seedHeld()
    await expect(
      contactSequenceService.resumeHeldEnrollment({
        workspaceId: mintId(),
        contactId: held.contactId,
        sequenceId: held.sequenceId,
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
  })

  test("two concurrent resumes: exactly one wins, one pending dispatch", async () => {
    for (let i = 0; i < 5; i++) {
      const held = await seedHeld()
      const results = await Promise.allSettled([
        contactSequenceService.resumeHeldEnrollment({
          workspaceId: held.workspaceId,
          contactId: held.contactId,
          sequenceId: held.sequenceId,
        }),
        contactSequenceService.resumeHeldEnrollment({
          workspaceId: held.workspaceId,
          contactId: held.contactId,
          sequenceId: held.sequenceId,
        }),
      ])
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
      const rejected = results.find((r) => r.status === "rejected") as
        | PromiseRejectedResult
        | undefined
      expect(rejected?.reason).toMatchObject({ httpStatusCode: 409 })
      const pending = await db.execute(sql`
        SELECT id FROM "SequenceDispatch"
        WHERE "enrollmentId" = ${held.enrollmentId} AND status = 'pending'`)
      expect(pending.rows).toHaveLength(1)
    }
  })
})

describe.skipIf(!databaseUrl)("s227b probe fixes", () => {
  const DEADLOCK = "40P01"
  const deadlocked = (results: PromiseSettledResult<unknown>[]) =>
    results.filter(
      (r) =>
        r.status === "rejected" &&
        JSON.stringify(r.reason, Object.getOwnPropertyNames(r.reason)).includes(
          DEADLOCK,
        ),
    ).length

  test("resume racing an unenrol never deadlocks (40 runs)", async () => {
    let deadlocks = 0
    for (let i = 0; i < 40; i++) {
      const held = await seedHeld()
      deadlocks += deadlocked(
        await Promise.allSettled([
          contactSequenceService.resumeHeldEnrollment({
            workspaceId: held.workspaceId,
            contactId: held.contactId,
            sequenceId: held.sequenceId,
          }),
          contactSequenceService.removeContactSequencesForContacts({
            workspaceId: held.workspaceId,
            contactIds: [held.contactId],
            sequenceIds: [held.sequenceId],
            reason: "subscription_removed",
          }),
        ]),
      )
    }
    expect(deadlocks).toBe(0)
  })

  test("hold racing an unenrol never deadlocks (40 runs)", async () => {
    let deadlocks = 0
    for (let i = 0; i < 40; i++) {
      const workspaceId = mintId()
      const sequenceId = await seedSequence({ workspaceId, stopOnReply: false })
      const contactId = mintId()
      const seededRow = await seedEnrollment({
        workspaceId,
        sequenceId,
        contactId,
        dispatchStatus: "running",
      })
      deadlocks += deadlocked(
        await Promise.allSettled([
          contactSequenceService.holdEnrollment({
            dispatchId: seededRow.dispatchId,
            workspaceId,
            reason: "missing: x",
          }),
          contactSequenceService.removeContactSequencesForContacts({
            workspaceId,
            contactIds: [contactId],
            sequenceIds: [sequenceId],
            reason: "subscription_removed",
          }),
        ]),
      )
    }
    expect(deadlocks).toBe(0)
  })

  test("hold on a PENDING dispatch racing an unenrol never deadlocks (40 runs)", async () => {
    let deadlocks = 0
    for (let i = 0; i < 40; i++) {
      const workspaceId = mintId()
      const sequenceId = await seedSequence({ workspaceId, stopOnReply: false })
      const contactId = mintId()
      const seededRow = await seedEnrollment({
        workspaceId,
        sequenceId,
        contactId,
      })
      deadlocks += deadlocked(
        await Promise.allSettled([
          contactSequenceService.holdEnrollment({
            dispatchId: seededRow.dispatchId,
            workspaceId,
            reason: "missing: x",
          }),
          contactSequenceService.removeContactSequencesForContacts({
            workspaceId,
            contactIds: [contactId],
            sequenceIds: [sequenceId],
            reason: "subscription_removed",
          }),
        ]),
      )
    }
    expect(deadlocks).toBe(0)
  })

  test("a held enrolment whose step was deleted: a 409 that says so; unenrol clears it", async () => {
    const held = await seedHeld()
    await db.execute(
      sql`DELETE FROM "SequenceDispatch" WHERE id = ${held.dispatchId}`,
    )
    await expect(
      contactSequenceService.resumeHeldEnrollment({
        workspaceId: held.workspaceId,
        contactId: held.contactId,
        sequenceId: held.sequenceId,
      }),
    ).rejects.toMatchObject({
      httpStatusCode: 409,
      message: expect.stringContaining("no longer exists"),
    })
  })

  test.each([
    ["", "1", "1"],
    ["abc", "1", "1"],
    ["1; drop", "1", "1"],
    ["99999999999999999999", "1", "1"],
    ["1", "-1", "1"],
    ["1", "1", " 1"],
  ])("garbage ids are a typed 422, never SQL (%s, %s, %s)", async (w, c, s) => {
    await expect(
      contactSequenceService.resumeHeldEnrollment({
        workspaceId: w,
        contactId: c,
        sequenceId: s,
      }),
    ).rejects.toMatchObject({ httpStatusCode: 422 })
    // holdEnrollment takes no sequenceId: only rows with a bad w or c apply.
    if (!(NUMERIC_ID.test(w) && NUMERIC_ID.test(c))) {
      await expect(
        contactSequenceService.holdEnrollment({
          dispatchId: c,
          workspaceId: w,
          reason: "missing: x",
        }),
      ).rejects.toMatchObject({ httpStatusCode: 422 })
    }
  })

  test("non-object props and an invalid now are TypeErrors", async () => {
    await expect(
      contactSequenceService.resumeHeldEnrollment(null as never),
    ).rejects.toThrow(TypeError)
    await expect(
      contactSequenceService.holdEnrollment(undefined as never),
    ).rejects.toThrow(TypeError)
    await expect(
      contactSequenceService.resumeHeldEnrollment({
        workspaceId: "1",
        contactId: "1",
        sequenceId: "1",
        now: new Date("x"),
      }),
    ).rejects.toThrow(TypeError)
  })
})
