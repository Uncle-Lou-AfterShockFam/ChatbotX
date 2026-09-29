// @vitest-environment node

/**
 * Outreach B-1 (s225b): EmailThread.recordSent against a REAL Postgres. The
 * one-statement upsert must (a) create the thread once under concurrent
 * first sends, (b) append every concurrent follow-up key exactly once,
 * (c) never touch a thread pinned to another line, and (d) stay bounded at
 * EMAIL_THREAD_MAX_KEYS keeping the root. Run with
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, sql } from "@chatbotx.io/database/client"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"

vi.mock("../../src/audit/dispatcher", () => ({
  dispatchAuditRecord: vi.fn(async () => undefined),
}))

const databaseUrl = requireRealDatabaseUrl()

const { emailThreadService, EMAIL_THREAD_MAX_KEYS } = await import(
  "../../src/email-thread"
)

let nextId = 9_225_000_000_000_000n
function mintId(): string {
  nextId += 1n
  return nextId.toString()
}

const seeded: Record<string, string[]> = {
  Sequence: [],
  Inbox: [],
  Contact: [],
  Workspace: [],
}

async function asReplica(statement: ReturnType<typeof sql>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`)
    await tx.execute(statement)
  })
}

async function seed() {
  const workspaceId = mintId()
  const contactId = mintId()
  const sequenceId = mintId()
  const lineA = mintId()
  const lineB = mintId()
  await asReplica(sql`
    INSERT INTO "Workspace" (id, name, "ownerId") VALUES (${workspaceId}, ${`s225b thread ${workspaceId}`}, 1)`)
  seeded.Workspace?.push(workspaceId)
  await asReplica(sql`
    INSERT INTO "Contact" (id, "workspaceId") VALUES (${contactId}, ${workspaceId})`)
  seeded.Contact?.push(contactId)
  await asReplica(sql`
    INSERT INTO "Sequence" (id, name, "workspaceId") VALUES (${sequenceId}, ${`s225b ${sequenceId}`}, ${workspaceId})`)
  seeded.Sequence?.push(sequenceId)
  for (const id of [lineA, lineB]) {
    await asReplica(sql`
      INSERT INTO "Inbox" (id, name, channel, "sourceId", "workspaceId") VALUES (${id}, 'line', 'api', ${id}, ${workspaceId})`)
    seeded.Inbox?.push(id)
  }
  return { workspaceId, contactId, sequenceId, lineA, lineB }
}

afterEach(async () => {
  if (!databaseUrl) {
    return
  }
  const ws = seeded.Workspace ?? []
  if (ws.length > 0) {
    await asReplica(
      sql`DELETE FROM "EmailThread" WHERE "workspaceId" IN (${sql.join(
        ws.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )
  }
  for (const table of ["Sequence", "Inbox", "Contact", "Workspace"]) {
    const ids = seeded[table]?.splice(0) ?? []
    if (ids.length > 0) {
      await asReplica(sql`
        DELETE FROM ${sql.identifier(table)} WHERE id IN (${sql.join(
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

describe.skipIf(!databaseUrl)("emailThreadService.recordSent", () => {
  test("concurrent first sends create ONE thread; every key lands once, root first", async () => {
    const s = await seed()
    const ref = {
      workspaceId: s.workspaceId,
      contactId: s.contactId,
      sequenceId: s.sequenceId,
      lineInboxId: s.lineA,
    }
    const root = await emailThreadService.recordSent({
      ...ref,
      subject: "Saturday",
      key: "bt.root-000001",
    })
    expect(root?.keys).toEqual(["bt.root-000001"])
    const keys = Array.from(
      { length: 12 },
      (_, i) => `bt.follow-${String(i).padStart(4, "0")}`,
    )
    await Promise.all(
      keys.map((key) =>
        emailThreadService.recordSent({ ...ref, subject: "ignored", key }),
      ),
    )
    const row = await emailThreadService.find(ref)
    expect(row?.subject).toBe("Saturday")
    expect(row?.keys[0]).toBe("bt.root-000001")
    expect([...(row?.keys ?? [])].sort()).toEqual(
      ["bt.root-000001", ...keys].sort(),
    )
    const [{ n }] = (
      await db.execute(
        sql`SELECT count(*)::int AS n FROM "EmailThread" WHERE "workspaceId" = ${s.workspaceId}`,
      )
    ).rows as { n: number }[]
    expect(n).toBe(1)
  })

  test("a replayed key is not appended twice", async () => {
    const s = await seed()
    const ref = {
      workspaceId: s.workspaceId,
      contactId: s.contactId,
      sequenceId: s.sequenceId,
      lineInboxId: s.lineA,
    }
    await emailThreadService.recordSent({
      ...ref,
      subject: "s",
      key: "bt.root-000001",
    })
    await emailThreadService.recordSent({
      ...ref,
      subject: "s",
      key: "bt.two-0000001",
    })
    await emailThreadService.recordSent({
      ...ref,
      subject: "s",
      key: "bt.two-0000001",
    })
    expect((await emailThreadService.find(ref))?.keys).toEqual([
      "bt.root-000001",
      "bt.two-0000001",
    ])
  })

  test("a thread pinned to another line is never touched (null)", async () => {
    const s = await seed()
    const ref = {
      workspaceId: s.workspaceId,
      contactId: s.contactId,
      sequenceId: s.sequenceId,
    }
    await emailThreadService.recordSent({
      ...ref,
      lineInboxId: s.lineA,
      subject: "s",
      key: "bt.root-000001",
    })
    const other = await emailThreadService.recordSent({
      ...ref,
      lineInboxId: s.lineB,
      subject: "s",
      key: "bt.other-00001",
    })
    expect(other).toBeNull()
    const row = await emailThreadService.find(ref)
    expect(row?.lineInboxId).toBe(s.lineA)
    expect(row?.keys).toEqual(["bt.root-000001"])
  })

  test("the key list stays bounded: the root plus the newest keys", async () => {
    const s = await seed()
    const ref = {
      workspaceId: s.workspaceId,
      contactId: s.contactId,
      sequenceId: s.sequenceId,
      lineInboxId: s.lineA,
    }
    const all = Array.from(
      { length: EMAIL_THREAD_MAX_KEYS + 7 },
      (_, i) => `bt.k-${String(i).padStart(6, "0")}`,
    )
    for (const key of all) {
      await emailThreadService.recordSent({ ...ref, subject: "s", key })
    }
    const keys = (await emailThreadService.find(ref))?.keys ?? []
    expect(keys).toHaveLength(EMAIL_THREAD_MAX_KEYS)
    expect(keys[0]).toBe(all[0])
    expect(keys.slice(1)).toEqual(all.slice(-(EMAIL_THREAD_MAX_KEYS - 1)))
  })

  test("claimRoot: of N concurrent first sends (two lines) exactly ONE claims the root; releaseRoot gives back only a lone root", async () => {
    const s = await seed()
    const ref = {
      workspaceId: s.workspaceId,
      contactId: s.contactId,
      sequenceId: s.sequenceId,
    }
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        emailThreadService.claimRoot({
          ...ref,
          lineInboxId: i % 2 ? s.lineA : s.lineB,
          subject: `s${i}`,
          key: `bt.claim-${String(i).padStart(4, "0")}`,
        }),
      ),
    )
    const winners = results.filter(Boolean)
    expect(winners).toHaveLength(1)
    const row = await emailThreadService.find(ref)
    expect(row?.keys).toEqual(winners[0]?.keys)
    await emailThreadService.releaseRoot({ ...ref, key: "bt.not-the-root" })
    expect(await emailThreadService.find(ref)).not.toBeNull()
    // Once a follow-up joined, the thread stays even for the root's own key.
    const root = row?.keys[0] as string
    await emailThreadService.recordSent({
      ...ref,
      lineInboxId: row?.lineInboxId as string,
      subject: "x",
      key: "bt.follow-00001",
    })
    await emailThreadService.releaseRoot({ ...ref, key: root })
    expect((await emailThreadService.find(ref))?.keys).toEqual([
      root,
      "bt.follow-00001",
    ])
  })

  test("releaseRoot drops a lone unsent root, so the next attempt can claim again", async () => {
    const s = await seed()
    const ref = {
      workspaceId: s.workspaceId,
      contactId: s.contactId,
      sequenceId: s.sequenceId,
    }
    await emailThreadService.claimRoot({
      ...ref,
      lineInboxId: s.lineA,
      subject: "s",
      key: "bt.root-000001",
    })
    await emailThreadService.releaseRoot({ ...ref, key: "bt.root-000001" })
    expect(await emailThreadService.find(ref)).toBeNull()
    expect(
      await emailThreadService.claimRoot({
        ...ref,
        lineInboxId: s.lineB,
        subject: "s",
        key: "bt.root-000002",
      }),
    ).not.toBeNull()
  })
})
