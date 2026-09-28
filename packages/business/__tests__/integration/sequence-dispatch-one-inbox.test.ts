// @vitest-environment node

/**
 * A sequence step dispatches to ONE contact inbox (owner s220b), against a
 * REAL Postgres. Upstream looped over every inbox while the idempotency key
 * (workspace:enrollment:step:runAt) had no inbox, so a multi-inbox contact's
 * second insert violated the unique index: the subscribe API answered 500
 * (live on DEMO) and multi-inbox advances rolled back.
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

async function seedContactWithInboxes(
  inboxes: Array<{ lastIncomingMessageAt: string | null }>,
) {
  const workspaceId = mintId()
  const contactId = mintId()
  await asReplica(sql`
    INSERT INTO "Workspace" (id, name, "ownerId")
    VALUES (${workspaceId}, ${`s220b ${workspaceId}`}, 1)`)
  seeded.Workspace?.push(workspaceId)
  await asReplica(sql`
    INSERT INTO "Contact" (id, "workspaceId") VALUES (${contactId}, ${workspaceId})`)
  seeded.Contact?.push(contactId)
  const contactInboxIds: string[] = []
  for (const inbox of inboxes) {
    const inboxId = mintId()
    const contactInboxId = mintId()
    await asReplica(sql`
      INSERT INTO "Inbox" (id, name, "workspaceId", channel, "sourceId")
      VALUES (${inboxId}, ${`s220b ${inboxId}`}, ${workspaceId}, 'api',
              ${`s220b-inbox-${inboxId}`})`)
    seeded.Inbox?.push(inboxId)
    await asReplica(sql`
      INSERT INTO "ContactInbox"
        (id, "originalContactId", "contactId", "inboxId", channel, source, "sourceId",
         "lastIncomingMessageAt")
      VALUES (${contactInboxId}, ${contactId}, ${contactId}, ${inboxId}, 'api', 'api',
              ${`s220b-${contactInboxId}`}, ${inbox.lastIncomingMessageAt})`)
    seeded.ContactInbox?.push(contactInboxId)
    contactInboxIds.push(contactInboxId)
  }
  return { workspaceId, contactId, contactInboxIds }
}

describe.skipIf(!databaseUrl)(
  "one dispatch inbox per sequence step (owner s220b)",
  () => {
    test("picks the inbox the contact last wrote on; never more than one", async () => {
      const { getDispatchContactInboxes } = await import(
        "@chatbotx.io/sequence-scheduler"
      )
      const { workspaceId, contactId, contactInboxIds } =
        await seedContactWithInboxes([
          { lastIncomingMessageAt: "2026-09-27T10:00:00Z" },
          { lastIncomingMessageAt: "2026-09-28T10:00:00Z" },
          { lastIncomingMessageAt: null },
        ])

      const picked = await getDispatchContactInboxes(workspaceId, contactId)

      expect(picked.map((ci) => ci.id)).toEqual([contactInboxIds[1]])
    })

    test("a contact that never wrote still gets exactly one inbox", async () => {
      const { getDispatchContactInboxes } = await import(
        "@chatbotx.io/sequence-scheduler"
      )
      const { workspaceId, contactId } = await seedContactWithInboxes([
        { lastIncomingMessageAt: null },
        { lastIncomingMessageAt: null },
      ])

      expect(
        await getDispatchContactInboxes(workspaceId, contactId),
      ).toHaveLength(1)
    })

    test("the idempotency key still refuses a second dispatch for the same step on ANOTHER inbox (retry safety)", async () => {
      const { createDispatch } = await import("@chatbotx.io/sequence-scheduler")
      const { workspaceId, contactId, contactInboxIds } =
        await seedContactWithInboxes([
          { lastIncomingMessageAt: null },
          { lastIncomingMessageAt: null },
        ])
      const sequenceId = mintId()
      const stepId = mintId()
      const enrollmentId = mintId()
      await asReplica(sql`
      INSERT INTO "Sequence" (id, name, "workspaceId")
      VALUES (${sequenceId}, ${`s220b ${sequenceId}`}, ${workspaceId})`)
      seeded.Sequence?.push(sequenceId)
      await asReplica(sql`
      INSERT INTO "SequenceStep" (id, "order", "delayDays", "sequenceId")
      VALUES (${stepId}, 0, 0, ${sequenceId})`)
      seeded.SequenceStep?.push(stepId)
      await asReplica(sql`
      INSERT INTO "ContactOnSequence" (id, "contactId", "sequenceId", "workspaceId", status)
      VALUES (${enrollmentId}, ${contactId}, ${sequenceId}, ${workspaceId}, 'active')`)
      seeded.ContactOnSequence?.push(enrollmentId)

      const base = {
        workspaceId,
        sequenceId,
        contactId,
        stepId,
        enrollmentId,
        runAt: new Date(),
      }
      const first = await createDispatch({
        ...base,
        contactInboxId: contactInboxIds[0] as string,
      })
      seeded.SequenceDispatch?.push(first.id)
      const second = await createDispatch({
        ...base,
        contactInboxId: contactInboxIds[1] as string,
      }).then(
        () => "inserted",
        () => "refused",
      )

      expect(second).toBe("refused")
    })
  },
)
