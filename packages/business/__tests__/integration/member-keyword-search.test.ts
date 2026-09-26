// @vitest-environment node

/**
 * Member keyword search (`/space/<id>/agents?keyword=`), against a REAL
 * Postgres. Before s207 every keyword threw `Unknown relational filter field:
 * "user"`: the page count fed the relational `user` filter to a bare
 * relationsFilterToSQL. The keyword matches the member's name OR email
 * (case-insensitive, `%` / `_` literal), and the count agrees with the rows.
 *
 * Seeds run under `SET LOCAL session_replication_role = replica` (no
 * Workspace / Tenant rows) and are deleted afterwards. Run with
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, sql } from "@chatbotx.io/database/client"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, afterEach, describe, expect, test } from "vitest"
import { workspaceMemberService } from "../../src/workspace-member/service"

const databaseUrl = requireRealDatabaseUrl()

/** Ids far above any snowflake a scratch database would hold (own range). */
let nextId = 9_210_000_000_000_000n
function mintId(): string {
  nextId += 1n
  return nextId.toString()
}

const seeded: Record<string, string[]> = { WorkspaceMember: [], User: [] }

async function asReplica(statement: ReturnType<typeof sql>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`)
    await tx.execute(statement)
  })
}

async function seedMember(props: {
  workspaceId: string
  name: string | null
  email: string
}): Promise<string> {
  const userId = mintId()
  const memberId = mintId()
  await asReplica(sql`
    INSERT INTO "User" (id, name, email)
    VALUES (${userId}, ${props.name}, ${props.email})`)
  seeded.User?.push(userId)
  await asReplica(sql`
    INSERT INTO "WorkspaceMember" (id, "workspaceId", "userId", role)
    VALUES (${memberId}, ${props.workspaceId}, ${userId}, 'agent')`)
  seeded.WorkspaceMember?.push(memberId)
  return memberId
}

/** Four members in one workspace plus a lookalike in another. */
async function seedWorkspace() {
  const workspaceId = mintId()
  const otherWorkspaceId = mintId()
  const ada = await seedMember({
    workspaceId,
    name: "Ada Lovelace",
    email: `ada-${workspaceId}@example.test`,
  })
  const grace = await seedMember({
    workspaceId,
    name: "Grace Hopper",
    email: `cobol_fan-${workspaceId}@example.test`,
  })
  const percent = await seedMember({
    workspaceId,
    name: "100% Agent",
    email: `pct-${workspaceId}@example.test`,
  })
  const unnamed = await seedMember({
    workspaceId,
    name: null,
    email: `nameless-${workspaceId}@example.test`,
  })
  await seedMember({
    workspaceId: otherWorkspaceId,
    name: "Ada Elsewhere",
    email: `ada-other-${workspaceId}@example.test`,
  })
  return { workspaceId, ada, grace, percent, unnamed }
}

async function search(workspaceId: string, keyword: string | null) {
  const result = await workspaceMemberService.listPaginated({
    workspaceId,
    keyword,
    perPage: 2,
  })
  return { ids: result.data.map((row) => row.id), pageCount: result.pageCount }
}

afterEach(async () => {
  if (!databaseUrl) {
    return
  }
  for (const table of ["WorkspaceMember", "User"]) {
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

describe("workspaceMemberService.listPaginated keyword (real Postgres)", () => {
  test("a name keyword returns the member and a matching page count", async () => {
    const { workspaceId, ada } = await seedWorkspace()

    expect(await search(workspaceId, "lovelace")).toEqual({
      ids: [ada],
      pageCount: 1,
    })
  })

  test("an email keyword matches, including a member with no name", async () => {
    const { workspaceId, unnamed } = await seedWorkspace()

    expect(await search(workspaceId, "NAMELESS-")).toEqual({
      ids: [unnamed],
      pageCount: 1,
    })
  })

  test("the count spans pages and stays inside the workspace", async () => {
    const { workspaceId, ada, grace, percent, unnamed } = await seedWorkspace()

    // Every seeded email in this workspace carries its id; the lookalike in
    // the other workspace carries it too and must not be counted.
    const all = await search(workspaceId, `-${workspaceId}@`)
    expect(all.pageCount).toBe(2)
    expect(all.ids).toEqual([ada, grace])

    const everyone = await search(workspaceId, null)
    expect(everyone.pageCount).toBe(2)
    expect([ada, grace, percent, unnamed]).toEqual(
      expect.arrayContaining(everyone.ids),
    )
  })

  test("% and _ are literal, not wildcards", async () => {
    const { workspaceId, grace, percent } = await seedWorkspace()

    expect(await search(workspaceId, "0%")).toEqual({
      ids: [percent],
      pageCount: 1,
    })
    expect(await search(workspaceId, "l_f")).toEqual({
      ids: [grace],
      pageCount: 1,
    })
    // As wildcards these would match "Ada Lovelace".
    expect(await search(workspaceId, "a%e")).toEqual({ ids: [], pageCount: 0 })
    expect(await search(workspaceId, "a_a")).toEqual({ ids: [], pageCount: 0 })
  })

  test("a blank keyword is no filter; no match is an empty page", async () => {
    const { workspaceId } = await seedWorkspace()

    expect((await search(workspaceId, "   ")).pageCount).toBe(2)
    expect(await search(workspaceId, "zzz-no-such-member")).toEqual({
      ids: [],
      pageCount: 0,
    })
  })
})
