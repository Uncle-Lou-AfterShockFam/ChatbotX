// @vitest-environment node

/**
 * `broadcastService.scheduleDraft` against a REAL Postgres (s208). Scheduling
 * a draft whose stored `contactFilter` the worker would refuse (malformed, or
 * an email/phone condition the scheduling member cannot use) must reject
 * with a 422 AND roll the draft -> scheduled UPDATE back, so the operator
 * learns at schedule time and the row stays an editable draft instead of
 * failing silently in `prepare-broadcast`.
 *
 * Seeds run under `SET LOCAL session_replication_role = replica` (no
 * Workspace row) and are deleted afterwards. Run with
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, sql } from "@chatbotx.io/database/client"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, afterEach, describe, expect, test } from "vitest"
import { broadcastService } from "../../src/broadcast/service"

const databaseUrl = requireRealDatabaseUrl()

/** Ids far above any snowflake a scratch database would hold (own range). */
let nextId = 9_220_000_000_000_000n
function mintId(): string {
  nextId += 1n
  return nextId.toString()
}

const seededBroadcasts: string[] = []

async function asReplica(statement: ReturnType<typeof sql>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`)
    await tx.execute(statement)
  })
}

/** One channel-mode draft in its own workspace with `contactFilter` stored as-is. */
async function seedDraft(contactFilter: unknown) {
  const workspaceId = mintId()
  const broadcastId = mintId()
  await asReplica(sql`
    INSERT INTO "Broadcast"
      (id, name, "workspaceId", status, "schedulesType", "schedulesAt",
       "contactFilter", subaction, channel)
    VALUES (${broadcastId}, 's208 draft', ${workspaceId}, 'draft', 'future',
            now(), ${contactFilter === null ? null : JSON.stringify(contactFilter)}::jsonb,
            'allContacts', 'messenger')`)
  seededBroadcasts.push(broadcastId)
  return { workspaceId, broadcastId }
}

async function statusOf(broadcastId: string): Promise<string | undefined> {
  const result = await db.execute<{ status: string }>(
    sql`SELECT status FROM "Broadcast" WHERE id = ${broadcastId}`,
  )
  return result.rows[0]?.status
}

const schedule = (
  draft: { workspaceId: string; broadcastId: string },
  canViewEmailAndPhone: boolean,
) =>
  broadcastService.scheduleDraft({
    ...draft,
    schedulesType: "future",
    schedulesAt: new Date(Date.now() + 86_400_000),
    canViewEmailAndPhone,
  })

afterEach(async () => {
  if (!databaseUrl) {
    return
  }
  const ids = seededBroadcasts.splice(0)
  if (ids.length > 0) {
    await asReplica(sql`
      DELETE FROM "Broadcast"
       WHERE id IN (${sql.join(
         ids.map((id) => sql`${id}`),
         sql`, `,
       )})`)
  }
})

afterAll(async () => {
  if (!databaseUrl) {
    return
  }
  await db.$client.end()
})

describe.skipIf(!databaseUrl)(
  "broadcastService.scheduleDraft refuses a stored filter it cannot send (real Postgres)",
  () => {
    test("a malformed stored filter rejects 422 and the row stays a draft", async () => {
      const draft = await seedDraft({ operator: "xor", conditions: [] })

      await expect(schedule(draft, true)).rejects.toMatchObject({
        field: "contactFilter",
        httpStatusCode: 422,
      })
      expect(await statusOf(draft.broadcastId)).toBe("draft")
    })

    test("an email condition rejects a member without emailAndPhone; the row stays a draft", async () => {
      const draft = await seedDraft({
        operator: "and",
        conditions: [{ field: "email", operator: "isNotEmpty" }],
      })

      await expect(schedule(draft, false)).rejects.toMatchObject({
        field: "contactFilter",
        httpStatusCode: 422,
      })
      expect(await statusOf(draft.broadcastId)).toBe("draft")
    })

    test("control: the same email filter schedules for a member who may use it", async () => {
      const draft = await seedDraft({
        operator: "and",
        conditions: [{ field: "email", operator: "isNotEmpty" }],
      })

      await expect(schedule(draft, true)).resolves.toEqual({
        id: draft.broadcastId,
      })
      expect(await statusOf(draft.broadcastId)).toBe("scheduled")
    })

    test("control: a null (everyone) filter schedules", async () => {
      const draft = await seedDraft(null)

      await expect(schedule(draft, false)).resolves.toEqual({
        id: draft.broadcastId,
      })
      expect(await statusOf(draft.broadcastId)).toBe("scheduled")
    })
  },
)
