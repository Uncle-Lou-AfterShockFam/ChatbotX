// @vitest-environment node

/**
 * Sequence out-of-office pause (s226b), against a REAL Postgres.
 *
 * `pauseForAutoReply` holds the contact's stop-on-reply enrolments for 14
 * days instead of ending them: pausedUntil set, the pending dispatch moved
 * to it (never earlier), running ones untouched; a repeat re-extends from
 * now without stacking; other sequences, contacts and enrolments that began
 * after the answer are untouched.
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
let nextId = 9_226_500_000_000_000n
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
    VALUES (${id}, ${`s226b ${id}`}, ${props.workspaceId}, ${props.stopOnReply})`)
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
    VALUES (${dispatchId}, ${Date.now() + 86_400_000}, ${`s226b-${dispatchId}`},
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

describe.skipIf(!databaseUrl)("pauseForAutoReply", () => {
  test("pauses only the answering contact's stop-on-reply enrolments; the pending dispatch moves to the pause end", async () => {
    rescheduled.mockReset()
    const workspaceId = mintId()
    const stopSeq = await seedSequence({ workspaceId, stopOnReply: true })
    const keepSeq = await seedSequence({ workspaceId, stopOnReply: false })
    const contact = mintId()
    const other = mintId()
    const paused = await seedEnrollment({
      workspaceId,
      sequenceId: stopSeq,
      contactId: contact,
    })
    const running = await seedEnrollment({
      workspaceId,
      sequenceId: stopSeq,
      contactId: other,
      dispatchStatus: "running",
    })
    const kept = await seedEnrollment({
      workspaceId,
      sequenceId: keepSeq,
      contactId: contact,
    })
    const now = new Date()
    const ids = await contactSequenceService.pauseForAutoReply({
      workspaceId,
      contactId: contact,
      occurredAt: now,
      now,
    })
    expect(ids).toEqual([stopSeq])
    const until = now.getTime() + 14 * DAY
    const enrol = await row("ContactOnSequence", paused.enrollmentId)
    expect(new Date(enrol?.pausedUntil as string).getTime()).toBe(until)
    expect(new Date(enrol?.nextRunAt as string).getTime()).toBe(until)
    expect(enrol?.status).toBe("active")
    expect(
      Number((await row("SequenceDispatch", paused.dispatchId))?.runAtMs),
    ).toBe(until)
    expect(rescheduled).toHaveBeenCalledWith([
      expect.objectContaining({
        id: paused.dispatchId,
        runAtMs: String(until),
      }),
    ])
    // Untouched: the rule-off sequence, and another contact's enrolment.
    expect(
      (await row("ContactOnSequence", kept.enrollmentId))?.pausedUntil,
    ).toBeNull()
    expect(
      (await row("ContactOnSequence", running.enrollmentId))?.pausedUntil,
    ).toBeNull()
  })

  test("a repeated out-of-office re-extends from now and never stacks; a dispatch already later than the pause stays", async () => {
    rescheduled.mockReset()
    const workspaceId = mintId()
    const seq = await seedSequence({ workspaceId, stopOnReply: true })
    const contact = mintId()
    const e = await seedEnrollment({
      workspaceId,
      sequenceId: seq,
      contactId: contact,
    })
    const t0 = new Date()
    await contactSequenceService.pauseForAutoReply({
      workspaceId,
      contactId: contact,
      occurredAt: t0,
      now: t0,
    })
    const t1 = new Date(t0.getTime() + DAY)
    await contactSequenceService.pauseForAutoReply({
      workspaceId,
      contactId: contact,
      occurredAt: t1,
      now: t1,
    })
    const enrol = await row("ContactOnSequence", e.enrollmentId)
    expect(new Date(enrol?.pausedUntil as string).getTime()).toBe(
      t1.getTime() + 14 * DAY,
    )
    expect(Number((await row("SequenceDispatch", e.dispatchId))?.runAtMs)).toBe(
      t1.getTime() + 14 * DAY,
    )
    // A dispatch due 30 days out is never pulled earlier.
    const far = t1.getTime() + 30 * DAY
    await asReplica(
      sql`UPDATE "SequenceDispatch" SET "runAtMs" = ${far} WHERE id = ${e.dispatchId}`,
    )
    await contactSequenceService.pauseForAutoReply({
      workspaceId,
      contactId: contact,
      occurredAt: t1,
      now: t1,
    })
    expect(Number((await row("SequenceDispatch", e.dispatchId))?.runAtMs)).toBe(
      far,
    )
  })

  test("an enrolment that began after the answer is not paused; bad input is refused", async () => {
    const workspaceId = mintId()
    const seq = await seedSequence({ workspaceId, stopOnReply: true })
    const contact = mintId()
    const later = await seedEnrollment({
      workspaceId,
      sequenceId: seq,
      contactId: contact,
      enrolledAt: new Date(),
    })
    const ids = await contactSequenceService.pauseForAutoReply({
      workspaceId,
      contactId: contact,
      occurredAt: new Date(Date.now() - 3_600_000),
    })
    expect(ids).toEqual([])
    expect(
      (await row("ContactOnSequence", later.enrollmentId))?.pausedUntil,
    ).toBeNull()
    await expect(
      contactSequenceService.pauseForAutoReply({
        workspaceId,
        contactId: contact,
        occurredAt: new Date("x"),
      }),
    ).rejects.toThrow(TypeError)
    await expect(
      contactSequenceService.pauseForAutoReply({
        workspaceId,
        contactId: contact,
        occurredAt: new Date(),
        pauseMs: 15 * DAY,
      }),
    ).rejects.toThrow(RangeError)
  })

  test("the moved dispatch lands inside the step's send window, not at the raw pause end", async () => {
    rescheduled.mockReset()
    const workspaceId = mintId()
    const seq = await seedSequence({ workspaceId, stopOnReply: true })
    const contact = mintId()
    const e = await seedEnrollment({
      workspaceId,
      sequenceId: seq,
      contactId: contact,
      window: { start: "09:00", end: "10:00", days: null },
    })
    // Pause ends 23:30 server time -> the next 09:00 window.
    const now = new Date(2026, 9, 1, 23, 30)
    await contactSequenceService.pauseForAutoReply({
      workspaceId,
      contactId: contact,
      occurredAt: new Date(),
      now,
    })
    const runAt = new Date(
      Number((await row("SequenceDispatch", e.dispatchId))?.runAtMs),
    )
    expect(runAt.getTime()).toBeGreaterThan(now.getTime() + 14 * DAY)
    // The validator reads SERVER-local hours (netcup runs UTC).
    expect(runAt.getHours()).toBe(9)
  })

  test("deferIfPaused: a CLAIMED step of a paused enrolment goes back to pending at the pause end; unpaused or expired sends now", async () => {
    const workspaceId = mintId()
    const seq = await seedSequence({ workspaceId, stopOnReply: true })
    const contact = mintId()
    const e = await seedEnrollment({
      workspaceId,
      sequenceId: seq,
      contactId: contact,
      dispatchStatus: "running",
    })
    expect(
      await contactSequenceService.deferIfPaused({
        dispatchId: e.dispatchId,
        workspaceId,
      }),
    ).toBeNull()
    const now = new Date()
    await contactSequenceService.pauseForAutoReply({
      workspaceId,
      contactId: contact,
      occurredAt: now,
      now,
    })
    const deferred = await contactSequenceService.deferIfPaused({
      dispatchId: e.dispatchId,
      workspaceId,
    })
    expect(deferred?.runAtMs).toBe(now.getTime() + 14 * DAY)
    const d = await row("SequenceDispatch", e.dispatchId)
    expect(d?.status).toBe("pending")
    expect(Number(d?.runAtMs)).toBe(now.getTime() + 14 * DAY)
    // Past the pause end: the step sends.
    await asReplica(
      sql`UPDATE "SequenceDispatch" SET status = 'running' WHERE id = ${e.dispatchId}`,
    )
    expect(
      await contactSequenceService.deferIfPaused({
        dispatchId: e.dispatchId,
        workspaceId,
        now: new Date(now.getTime() + 15 * DAY),
      }),
    ).toBeNull()
  })
})
