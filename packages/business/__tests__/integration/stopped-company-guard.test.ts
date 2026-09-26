// @vitest-environment node

/**
 * The stopped-company guard on smart-delay rows, against a REAL Postgres.
 *
 * A company stop is permanent: it commits `Company.stoppedAt`, then cancels
 * every active wait of the company's contacts. A wait written after that
 * cancel pass (a step that started before the stop), or one the pass skipped
 * on a held lock (a `partial` stop), is caught by `isContactInboxStopped`
 * (checked after the write and at every resume). The re-sweep an
 * `already_stopped` trigger runs is covered in `company-stop.test.ts`.
 *
 * Seeds run under `SET LOCAL session_replication_role = replica` (no
 * Workspace / Conversation / Inbox rows) and are deleted afterwards. Run with
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, sql } from "@chatbotx.io/database/client"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"
import { smartDelayService } from "../../src/smart-delay"

// The cancel loop drops each canceled row's delayed BullMQ job; no Redis here.
vi.mock("@chatbotx.io/worker-config", () => ({
  integrationQueue: { remove: vi.fn().mockResolvedValue(undefined) },
}))
const databaseUrl = requireRealDatabaseUrl()

/** Ids far above any snowflake a scratch database would hold (own range). */
let nextId = 9_200_000_000_000_000n
function mintId(): string {
  nextId += 1n
  return nextId.toString()
}

const seeded: Record<string, string[]> = {
  ContactOnSmartDelay: [],
  ContactInbox: [],
  Contact: [],
  Company: [],
}

async function asReplica(statement: ReturnType<typeof sql>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`)
    await tx.execute(statement)
  })
}

/** One company with one contact on one inbox. */
async function seedContact(props: {
  workspaceId: string
  stopped: boolean
  withCompany?: boolean
}) {
  const companyId = mintId()
  const contactId = mintId()
  const contactInboxId = mintId()
  const withCompany = props.withCompany ?? true
  if (withCompany) {
    await asReplica(sql`
      INSERT INTO "Company" (id, name, "workspaceId", "stoppedAt", "stopReason")
      VALUES (${companyId}, ${`s203 guard ${companyId}`}, ${props.workspaceId},
              ${props.stopped ? sql`now()` : sql`NULL`},
              ${props.stopped ? "api" : null})`)
    seeded.Company?.push(companyId)
  }
  await asReplica(sql`
    INSERT INTO "Contact" (id, "workspaceId", "companyId")
    VALUES (${contactId}, ${props.workspaceId},
            ${withCompany ? companyId : null})`)
  seeded.Contact?.push(contactId)
  await asReplica(sql`
    INSERT INTO "ContactInbox"
      (id, "originalContactId", "contactId", "inboxId", channel, source, "sourceId")
    VALUES (${contactInboxId}, ${contactId}, ${contactId}, 1, 'api', 'api',
            ${`s203-${contactInboxId}`})`)
  seeded.ContactInbox?.push(contactInboxId)
  return { companyId, contactId, contactInboxId }
}

async function seedWait(props: {
  workspaceId: string
  contactInboxId: string
  status: "pending" | "scheduled" | "running" | "completed"
  claimGeneration?: number
}): Promise<string> {
  const id = mintId()
  await asReplica(sql`
    INSERT INTO "ContactOnSmartDelay"
      (id, "workspaceId", "flowId", "contactInboxId", "conversationId",
       "nodeId", type, "triggerAt", status, "claimGeneration", "claimedAt")
    VALUES (${id}, ${props.workspaceId}, 1, ${props.contactInboxId}, 1,
            'next-node', 'waitNode', now() + interval '1 hour',
            ${props.status}::"ContactOnSmartDelayStatus",
            ${props.claimGeneration ?? 0},
            ${props.status === "running" ? sql`now()` : sql`NULL`})`)
  seeded.ContactOnSmartDelay?.push(id)
  return id
}

async function statusOf(id: string): Promise<string | undefined> {
  const result = await db.execute<{ status: string }>(sql`
    SELECT status FROM "ContactOnSmartDelay" WHERE id = ${id}`)
  return result.rows[0]?.status
}

afterEach(async () => {
  if (!databaseUrl) {
    return
  }
  // Children first: the Contact -> Company FK is ON DELETE SET NULL anyway,
  // but deleting in this order keeps every statement FK-clean.
  for (const table of [
    "ContactOnSmartDelay",
    "ContactInbox",
    "Contact",
    "Company",
  ]) {
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

describe.skipIf(!databaseUrl)("isContactInboxStopped", () => {
  test("true only for a contact of a stopped company in the same workspace", async () => {
    const workspaceId = mintId()
    const stopped = await seedContact({ workspaceId, stopped: true })
    const live = await seedContact({ workspaceId, stopped: false })
    const loose = await seedContact({
      workspaceId,
      stopped: false,
      withCompany: false,
    })

    const check = (contactInboxId: string, ws = workspaceId) =>
      smartDelayService.isContactInboxStopped({
        workspaceId: ws,
        contactInboxId,
      })
    expect(await check(stopped.contactInboxId)).toBe(true)
    expect(await check(live.contactInboxId)).toBe(false)
    expect(await check(loose.contactInboxId)).toBe(false)
    expect(await check(stopped.contactInboxId, mintId())).toBe(false)
    expect(await check(mintId())).toBe(false)
  })
})

describe.skipIf(!databaseUrl)(
  "a wait written after the stop's cancel pass",
  () => {
    test("the post-write check sees the stamp and cancels the row", async () => {
      const workspaceId = mintId()
      const { companyId, contactId, contactInboxId } = await seedContact({
        workspaceId,
        stopped: false,
      })
      // The stop commits its stamp and its cancel pass finds nothing ...
      await asReplica(sql`
      UPDATE "Company" SET "stoppedAt" = now() WHERE id = ${companyId}`)
      expect(
        await smartDelayService.hasActiveForContacts({
          workspaceId,
          contactIds: [contactId],
        }),
      ).toBe(false)
      // ... then the in-flight step writes its wait.
      const row = await seedWait({
        workspaceId,
        contactInboxId,
        status: "pending",
      })

      expect(
        await smartDelayService.isContactInboxStopped({
          workspaceId,
          contactInboxId,
        }),
      ).toBe(true)
      expect(await smartDelayService.cancelIfNotStarted({ id: row })).toBe(true)
      expect(await statusOf(row)).toBe("canceled")
    })

    test("cancelIfNotStarted leaves running and terminal rows alone", async () => {
      const workspaceId = mintId()
      const { contactInboxId } = await seedContact({
        workspaceId,
        stopped: true,
      })
      const scheduled = await seedWait({
        workspaceId,
        contactInboxId,
        status: "scheduled",
      })
      const running = await seedWait({
        workspaceId,
        contactInboxId,
        status: "running",
        claimGeneration: 1,
      })
      const done = await seedWait({
        workspaceId,
        contactInboxId,
        status: "completed",
      })

      expect(
        await smartDelayService.cancelIfNotStarted({ id: scheduled }),
      ).toBe(true)
      expect(await smartDelayService.cancelIfNotStarted({ id: running })).toBe(
        false,
      )
      expect(await smartDelayService.cancelIfNotStarted({ id: done })).toBe(
        false,
      )
      expect([
        await statusOf(scheduled),
        await statusOf(running),
        await statusOf(done),
      ]).toEqual(["canceled", "running", "completed"])
    })

    test("a claimed run cancels its own row, only with its generation", async () => {
      const workspaceId = mintId()
      const { contactInboxId } = await seedContact({
        workspaceId,
        stopped: true,
      })
      const row = await seedWait({
        workspaceId,
        contactInboxId,
        status: "running",
        claimGeneration: 2,
      })

      expect(
        await smartDelayService.finishClaimedRun({
          id: row,
          generation: 1,
          to: "canceled",
        }),
      ).toBe(false)
      expect(
        await smartDelayService.finishClaimedRun({
          id: row,
          generation: 2,
          to: "canceled",
        }),
      ).toBe(true)
      expect(await statusOf(row)).toBe("canceled")
    })
  },
)
