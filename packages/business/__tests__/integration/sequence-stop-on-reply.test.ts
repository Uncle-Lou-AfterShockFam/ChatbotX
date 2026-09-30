// @vitest-environment node

/**
 * Sequence stop-on-reply (s220b), against a REAL Postgres.
 *
 * `removeStopOnReplyEnrollments` ends the replying contact's enrolments in
 * every `stopOnReply` sequence of the workspace, and nothing else: the same
 * contact's enrolment in a sequence with the rule off, another contact's
 * enrolment in the stop sequence, and any other workspace are untouched.
 * The enrolment's pending dispatch goes with it (FK cascade), which is what
 * makes an already-queued step a no-op at send time (`findRunning`).
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
vi.mock("@chatbotx.io/sequence-scheduler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/sequence-scheduler")>()),
  removeDispatchesFromSchedule: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@chatbotx.io/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/events")>()),
  emitSequenceUnsubscribed: vi.fn().mockResolvedValue(undefined),
}))

const { contactSequenceService } = await import("../../src/contact-sequence")

const databaseUrl = requireRealDatabaseUrl()

/** Ids far above any snowflake a scratch database would hold (own range). */
let nextId = 9_220_000_000_000_000n
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
    VALUES (${id}, ${`s220b ${id}`}, ${props.workspaceId}, ${props.stopOnReply})`)
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
}): Promise<{ enrollmentId: string; dispatchId: string }> {
  const enrollmentId = mintId()
  const dispatchId = mintId()
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
    VALUES (${dispatchId}, ${Date.now() + 86_400_000}, ${`s220b-${dispatchId}`},
            ${props.workspaceId}, ${props.sequenceId}, ${props.contactId}, 1, 1,
            ${enrollmentId}, ${props.dispatchStatus ?? "pending"})`)
  seeded.SequenceDispatch?.push(dispatchId)
  return { enrollmentId, dispatchId }
}

async function exists(table: string, id: string): Promise<boolean> {
  const result = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE id = ${id}`)
  return (result.rows[0]?.n ?? 0) > 0
}

async function statusOf(table: string, id: string) {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT * FROM ${sql.identifier(table)} WHERE id = ${id}`)
  const row = result.rows[0]
  return { status: row?.status, endReason: row?.endReason }
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

describe.skipIf(!databaseUrl)("removeStopOnReplyEnrollments", () => {
  test("ends only the replying contact's stop-on-reply enrolments", async () => {
    const workspaceId = mintId()
    const stopSeq = await seedSequence({ workspaceId, stopOnReply: true })
    const keepSeq = await seedSequence({ workspaceId, stopOnReply: false })
    const replier = mintId()
    const bystander = mintId()

    const stopped = await seedEnrollment({
      workspaceId,
      sequenceId: stopSeq,
      contactId: replier,
    })
    const ruleOff = await seedEnrollment({
      workspaceId,
      sequenceId: keepSeq,
      contactId: replier,
    })
    const other = await seedEnrollment({
      workspaceId,
      sequenceId: stopSeq,
      contactId: bystander,
    })

    const ended = await contactSequenceService.removeStopOnReplyEnrollments({
      workspaceId,
      contactId: replier,
      repliedAt: new Date(),
    })

    expect(ended).toEqual([stopSeq])
    // s228b: the enrolment ENDS (kept, with the reason); its queued step is
    // canceled.
    expect(await statusOf("ContactOnSequence", stopped.enrollmentId)).toEqual({
      status: "ended",
      endReason: "contact_replied",
    })
    expect(await statusOf("SequenceDispatch", stopped.dispatchId)).toEqual({
      status: "canceled",
      endReason: undefined,
    })
    expect(await exists("ContactOnSequence", ruleOff.enrollmentId)).toBe(true)
    expect(await exists("SequenceDispatch", ruleOff.dispatchId)).toBe(true)
    expect(await exists("ContactOnSequence", other.enrollmentId)).toBe(true)
    expect(await exists("SequenceDispatch", other.dispatchId)).toBe(true)
  })

  test("a dispatch already claimed (running) is stopped at the send gate, never sent (s228b)", async () => {
    const workspaceId = mintId()
    const stopSeq = await seedSequence({ workspaceId, stopOnReply: true })
    const contactId = mintId()
    const claimed = await seedEnrollment({
      workspaceId,
      sequenceId: stopSeq,
      contactId,
      dispatchStatus: "running",
    })

    await contactSequenceService.removeStopOnReplyEnrollments({
      workspaceId,
      contactId,
      repliedAt: new Date(),
    })

    expect(
      await contactSequenceService.deferIfPaused({
        dispatchId: claimed.dispatchId,
        workspaceId,
      }),
    ).toBe("ended")
    expect(await statusOf("SequenceDispatch", claimed.dispatchId)).toEqual({
      status: "canceled",
      endReason: undefined,
    })
  })

  test("an enrolment made after the reply (a late or re-delivered event) is kept", async () => {
    const workspaceId = mintId()
    const stopSeq = await seedSequence({ workspaceId, stopOnReply: true })
    const contactId = mintId()
    const repliedAt = new Date(Date.now() - 180_000)
    const fresh = await seedEnrollment({
      workspaceId,
      sequenceId: stopSeq,
      contactId,
      enrolledAt: new Date(repliedAt.getTime() + 1000),
    })

    const ended = await contactSequenceService.removeStopOnReplyEnrollments({
      workspaceId,
      contactId,
      repliedAt,
    })

    expect(ended).toEqual([])
    expect(await exists("ContactOnSequence", fresh.enrollmentId)).toBe(true)
  })

  test("an invalid repliedAt is refused before any query", async () => {
    await expect(
      contactSequenceService.removeStopOnReplyEnrollments({
        workspaceId: mintId(),
        contactId: mintId(),
        repliedAt: new Date("nope"),
      }),
    ).rejects.toBeInstanceOf(TypeError)
  })

  test("the real dispatch FK error is recognised by name (the advance / bulk-enrol catch)", async () => {
    const { createDispatch } = await import("@chatbotx.io/sequence-scheduler")
    const { isForeignKeyViolationError } = await import(
      "@chatbotx.io/database/client"
    )
    // Every OTHER referenced row exists, as it does in the real race, so the
    // only FK the insert can trip is the (removed) enrolment's.
    const workspaceId = mintId()
    const contactId = mintId()
    const contactInboxId = mintId()
    const stepId = mintId()
    await asReplica(sql`
      INSERT INTO "Workspace" (id, name, "ownerId")
      VALUES (${workspaceId}, ${`s220b ${workspaceId}`}, 1)`)
    seeded.Workspace?.push(workspaceId)
    const sequenceId = await seedSequence({ workspaceId, stopOnReply: true })
    await asReplica(sql`
      INSERT INTO "Contact" (id, "workspaceId") VALUES (${contactId}, ${workspaceId})`)
    seeded.Contact?.push(contactId)
    await asReplica(sql`
      INSERT INTO "ContactInbox"
        (id, "originalContactId", "contactId", "inboxId", channel, source, "sourceId")
      VALUES (${contactInboxId}, ${contactId}, ${contactId}, 1, 'api', 'api',
              ${`s220b-${contactInboxId}`})`)
    seeded.ContactInbox?.push(contactInboxId)
    await asReplica(sql`
      INSERT INTO "SequenceStep" (id, "order", "delayDays", "sequenceId")
      VALUES (${stepId}, 0, 0, ${sequenceId})`)
    seeded.SequenceStep?.push(stepId)

    const error = await createDispatch({
      workspaceId,
      sequenceId,
      contactId,
      contactInboxId,
      stepId,
      enrollmentId: mintId(),
      runAt: new Date(),
    }).then(
      () => "inserted",
      (err: unknown) => err,
    )

    expect(
      isForeignKeyViolationError(
        error,
        "SequenceDispatch_enrollment_workspace_fkey",
      ),
    ).toBe(true)
  })

  test("a second reply is a no-op", async () => {
    const workspaceId = mintId()
    const stopSeq = await seedSequence({ workspaceId, stopOnReply: true })
    const contactId = mintId()
    await seedEnrollment({ workspaceId, sequenceId: stopSeq, contactId })

    const first = await contactSequenceService.removeStopOnReplyEnrollments({
      workspaceId,
      contactId,
      repliedAt: new Date(),
    })
    const second = await contactSequenceService.removeStopOnReplyEnrollments({
      workspaceId,
      contactId,
      repliedAt: new Date(),
    })

    expect(first).toEqual([stopSeq])
    expect(second).toEqual([])
  })

  test("never reaches another workspace's enrolment of the same contact id", async () => {
    const workspaceId = mintId()
    const otherWorkspaceId = mintId()
    const contactId = mintId()
    const foreignSeq = await seedSequence({
      workspaceId: otherWorkspaceId,
      stopOnReply: true,
    })
    const foreign = await seedEnrollment({
      workspaceId: otherWorkspaceId,
      sequenceId: foreignSeq,
      contactId,
    })

    const ended = await contactSequenceService.removeStopOnReplyEnrollments({
      workspaceId,
      contactId,
      repliedAt: new Date(),
    })

    expect(ended).toEqual([])
    expect(await exists("ContactOnSequence", foreign.enrollmentId)).toBe(true)
  })

  test("a contact with no enrolments costs one query and ends nothing", async () => {
    const ended = await contactSequenceService.removeStopOnReplyEnrollments({
      workspaceId: mintId(),
      contactId: mintId(),
      repliedAt: new Date(),
    })
    expect(ended).toEqual([])
  })
})
