// @vitest-environment node

/**
 * One sequence step dispatches once PER contact inbox (s220b), against a REAL
 * Postgres and its real `SequenceDispatch` idempotency unique index. Before
 * the inbox joined the key, the second inbox's insert violated the index:
 * the subscribe API answered 500 and every multi-inbox advance rolled back.
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, sql } from "@chatbotx.io/database/client"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, afterEach, describe, expect, test } from "vitest"

const databaseUrl = requireRealDatabaseUrl()

let nextId = 9_221_000_000_000_000n
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

describe.skipIf(!databaseUrl)("createDispatch per contact inbox", () => {
  test("two inboxes, same enrolment/step/runAt: both dispatches insert; a repeat per inbox is refused", async () => {
    const { createDispatch } = await import("@chatbotx.io/sequence-scheduler")
    const workspaceId = mintId()
    const sequenceId = mintId()
    const contactId = mintId()
    const stepId = mintId()
    const enrollmentId = mintId()
    const inboxA = mintId()
    const inboxB = mintId()

    await asReplica(sql`
      INSERT INTO "Workspace" (id, name, "ownerId")
      VALUES (${workspaceId}, ${`s220b ${workspaceId}`}, 1)`)
    seeded.Workspace?.push(workspaceId)
    await asReplica(sql`
      INSERT INTO "Sequence" (id, name, "workspaceId")
      VALUES (${sequenceId}, ${`s220b ${sequenceId}`}, ${workspaceId})`)
    seeded.Sequence?.push(sequenceId)
    await asReplica(sql`
      INSERT INTO "Contact" (id, "workspaceId") VALUES (${contactId}, ${workspaceId})`)
    seeded.Contact?.push(contactId)
    for (const inbox of [inboxA, inboxB]) {
      await asReplica(sql`
        INSERT INTO "ContactInbox"
          (id, "originalContactId", "contactId", "inboxId", channel, source, "sourceId")
        VALUES (${inbox}, ${contactId}, ${contactId}, 1, 'api', 'api', ${`s220b-${inbox}`})`)
      seeded.ContactInbox?.push(inbox)
    }
    await asReplica(sql`
      INSERT INTO "SequenceStep" (id, "order", "delayDays", "sequenceId")
      VALUES (${stepId}, 0, 0, ${sequenceId})`)
    seeded.SequenceStep?.push(stepId)
    await asReplica(sql`
      INSERT INTO "ContactOnSequence" (id, "contactId", "sequenceId", "workspaceId", status)
      VALUES (${enrollmentId}, ${contactId}, ${sequenceId}, ${workspaceId}, 'active')`)
    seeded.ContactOnSequence?.push(enrollmentId)

    const runAt = new Date()
    const base = {
      workspaceId,
      sequenceId,
      contactId,
      stepId,
      enrollmentId,
      runAt,
    }
    const a = await createDispatch({ ...base, contactInboxId: inboxA })
    const b = await createDispatch({ ...base, contactInboxId: inboxB })
    seeded.SequenceDispatch?.push(a.id, b.id)

    expect(a.id).not.toBe(b.id)
    const repeat = await createDispatch({
      ...base,
      contactInboxId: inboxA,
    }).then(
      () => "inserted",
      () => "refused",
    )
    expect(repeat).toBe("refused")
  })
})
