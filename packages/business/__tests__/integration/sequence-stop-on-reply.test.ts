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
  Sequence: [],
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
}): Promise<{ enrollmentId: string; dispatchId: string }> {
  const enrollmentId = mintId()
  const dispatchId = mintId()
  await asReplica(sql`
    INSERT INTO "ContactOnSequence"
      (id, "contactId", "sequenceId", "workspaceId", status, "nextRunAt")
    VALUES (${enrollmentId}, ${props.contactId}, ${props.sequenceId},
            ${props.workspaceId}, 'active', now() + interval '1 day')`)
  seeded.ContactOnSequence?.push(enrollmentId)
  await asReplica(sql`
    INSERT INTO "SequenceDispatch"
      (id, "runAtMs", "idempotencyKey", "workspaceId", "sequenceId",
       "contactId", "contactInboxId", "stepId", "enrollmentId")
    VALUES (${dispatchId}, ${Date.now() + 86_400_000}, ${`s220b-${dispatchId}`},
            ${props.workspaceId}, ${props.sequenceId}, ${props.contactId}, 1, 1,
            ${enrollmentId})`)
  seeded.SequenceDispatch?.push(dispatchId)
  return { enrollmentId, dispatchId }
}

async function exists(table: string, id: string): Promise<boolean> {
  const result = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE id = ${id}`)
  return (result.rows[0]?.n ?? 0) > 0
}

afterEach(async () => {
  if (!databaseUrl) {
    return
  }
  for (const table of ["SequenceDispatch", "ContactOnSequence", "Sequence"]) {
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
    })

    expect(ended).toEqual([stopSeq])
    expect(await exists("ContactOnSequence", stopped.enrollmentId)).toBe(false)
    // The queued step goes with the enrolment (FK cascade).
    expect(await exists("SequenceDispatch", stopped.dispatchId)).toBe(false)
    expect(await exists("ContactOnSequence", ruleOff.enrollmentId)).toBe(true)
    expect(await exists("SequenceDispatch", ruleOff.dispatchId)).toBe(true)
    expect(await exists("ContactOnSequence", other.enrollmentId)).toBe(true)
    expect(await exists("SequenceDispatch", other.dispatchId)).toBe(true)
  })

  test("a second reply is a no-op", async () => {
    const workspaceId = mintId()
    const stopSeq = await seedSequence({ workspaceId, stopOnReply: true })
    const contactId = mintId()
    await seedEnrollment({ workspaceId, sequenceId: stopSeq, contactId })

    const first = await contactSequenceService.removeStopOnReplyEnrollments({
      workspaceId,
      contactId,
    })
    const second = await contactSequenceService.removeStopOnReplyEnrollments({
      workspaceId,
      contactId,
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
    })

    expect(ended).toEqual([])
    expect(await exists("ContactOnSequence", foreign.enrollmentId)).toBe(true)
  })

  test("a contact with no enrolments costs one query and ends nothing", async () => {
    const ended = await contactSequenceService.removeStopOnReplyEnrollments({
      workspaceId: mintId(),
      contactId: mintId(),
    })
    expect(ended).toEqual([])
  })
})
