// @vitest-environment node

/**
 * s234a: a by-id folder write reaches the folder AND its subtree
 * (bulkDelete cascades through `paths`), so the flows gate reads the types
 * of the whole subtree; and a folder's parent must be this workspace's
 * folder of the same type, so a flow folder cannot hide under another type.
 *
 *     DATABASE_URL=postgres://... REQUIRE_REAL_DB=1 vitest run --dir __tests__/integration
 */

import { db, sql } from "@chatbotx.io/database/client"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, describe, expect, test, vi } from "vitest"

vi.mock("../../src/audit/dispatcher", () => ({
  dispatchAuditRecord: vi.fn().mockResolvedValue(undefined),
}))

const { folderService } = await import("../../src/folder/service")

const databaseUrl = requireRealDatabaseUrl()

let nextId = 9_223_100_500_000_000n
function mintId(): string {
  nextId += 1n
  return nextId.toString()
}

const workspaces: string[] = []

async function seedWorkspace(): Promise<string> {
  const id = mintId()
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`)
    await tx.execute(sql`
      INSERT INTO "Workspace" (id, name, "ownerId")
      VALUES (${id}, ${`s234a ${id}`}, 1)`)
  })
  workspaces.push(id)
  return id
}

/** A raw row: the legacy shape create() now refuses (flow under a tag folder). */
async function seedFolder(props: {
  workspaceId: string
  folderType: string
  paths: string[]
}): Promise<string> {
  const id = mintId()
  const parentId = props.paths.at(-1) ?? null
  await db.execute(sql`
    INSERT INTO "Folder" (id, name, "folderType", "parentId", "workspaceId", paths)
    VALUES (${id}, ${`f ${id}`}, ${props.folderType}::"folderType", ${parentId},
            ${props.workspaceId}, ${props.paths}::bigint[])`)
  return id
}

afterAll(async () => {
  if (!databaseUrl) {
    return
  }
  for (const id of workspaces) {
    await db.execute(sql`DELETE FROM "Folder" WHERE "workspaceId" = ${id}`)
    await db.execute(sql`DELETE FROM "Workspace" WHERE id = ${id}`)
  }
  await db.$client.end()
})

describe.skipIf(!databaseUrl)("folderService (s234a flows gate)", () => {
  test("subtreeFolderTypes sees a flow folder nested under a tag folder", async () => {
    const workspaceId = await seedWorkspace()
    const tag = await seedFolder({ workspaceId, folderType: "tag", paths: [] })
    const mid = await seedFolder({
      workspaceId,
      folderType: "tag",
      paths: [tag],
    })
    await seedFolder({ workspaceId, folderType: "flow", paths: [tag, mid] })

    expect(
      (await folderService.subtreeFolderTypes({ workspaceId, ids: [tag] }))
        .slice()
        .sort(),
    ).toEqual(["flow", "tag", "tag"])
    // The subtree the gate reads is the subtree bulkDelete removes.
    await folderService.bulkDelete({ workspaceId, ids: [tag] })
    expect(
      await folderService.subtreeFolderTypes({ workspaceId, ids: [tag] }),
    ).toEqual([])
  })

  test("subtreeFolderTypes is workspace-scoped and empty for no ids", async () => {
    const a = await seedWorkspace()
    const b = await seedWorkspace()
    const flowInB = await seedFolder({
      workspaceId: b,
      folderType: "flow",
      paths: [],
    })
    expect(
      await folderService.subtreeFolderTypes({
        workspaceId: a,
        ids: [flowInB],
      }),
    ).toEqual([])
    expect(
      await folderService.subtreeFolderTypes({ workspaceId: b, ids: [] }),
    ).toEqual([])
  })

  test("create refuses a parent of another type or another workspace", async () => {
    const workspaceId = await seedWorkspace()
    const other = await seedWorkspace()
    const tag = await seedFolder({ workspaceId, folderType: "tag", paths: [] })
    const foreignFlow = await seedFolder({
      workspaceId: other,
      folderType: "flow",
      paths: [],
    })

    for (const parentId of [tag, foreignFlow]) {
      await expect(
        folderService.create({
          workspaceId,
          data: { name: "x", parentId, folderType: "flow" },
        }),
      ).rejects.toThrow("Parent folder does not exist!")
    }

    const flowRoot = await folderService.create({
      workspaceId,
      data: { name: "root", parentId: null, folderType: "flow" },
    })
    const child = await folderService.create({
      workspaceId,
      data: { name: "child", parentId: flowRoot.id, folderType: "flow" },
    })
    expect(child.paths).toEqual([flowRoot.id])
  })
})
