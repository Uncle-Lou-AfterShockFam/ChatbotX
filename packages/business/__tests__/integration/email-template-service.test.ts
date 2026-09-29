// @vitest-environment node

/**
 * Email templates (B2 phase 2), against a REAL Postgres: every write goes
 * through parseDocument (closed schema, size cap) and becomes a 422 on the
 * offending field; names are unique per workspace; every read is scoped to
 * the workspace; a stored document is re-validated on read.
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, sql } from "@chatbotx.io/database/client"
import { DocumentValidationError } from "@chatbotx.io/email-document"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"

vi.mock("../../src/audit/dispatcher", () => ({
  dispatchAuditRecord: vi.fn().mockResolvedValue(undefined),
}))

const { emailTemplateService } = await import("../../src/email-templates")

const databaseUrl = requireRealDatabaseUrl()

let nextId = 9_223_000_000_000_000n
function mintId(): string {
  nextId += 1n
  return nextId.toString()
}

const workspaces: string[] = []

async function asReplica(statement: ReturnType<typeof sql>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`)
    await tx.execute(statement)
  })
}

async function seedWorkspace(): Promise<string> {
  const id = mintId()
  await asReplica(sql`
    INSERT INTO "Workspace" (id, name, "ownerId")
    VALUES (${id}, ${`s220b ${id}`}, 1)`)
  workspaces.push(id)
  return id
}

async function seedMediaFile(workspaceId: string): Promise<string> {
  const id = mintId()
  await asReplica(sql`
    INSERT INTO "MediaLibraryFile" (id, name, path, "mimeType", size, "workspaceId")
    VALUES (${id}, 'a.pdf', ${`public/space/${workspaceId}/media/${id}`},
            'application/pdf', 4, ${workspaceId})`)
  return id
}

const withAssets = (attachmentId: string, imageId: string) => ({
  version: 1,
  settings: {},
  blocks: [
    {
      id: "1",
      type: "attachment",
      asset: { kind: "media", fileId: attachmentId },
    },
    {
      id: "2",
      type: "columns",
      columns: [
        {
          blocks: [
            {
              id: "3",
              type: "image",
              src: { kind: "media", fileId: imageId },
              alt: "x",
            },
          ],
        },
        { blocks: [] },
      ],
    },
  ],
})

const DOCUMENT = {
  version: 1,
  settings: {},
  blocks: [{ id: "1", type: "text", text: "<p>Hi {{first_name}}</p>" }],
}

function expectValidation(error: unknown, field: string) {
  expect(error).toMatchObject({ httpStatusCode: 422, field })
}

afterEach(async () => {
  if (!databaseUrl) {
    return
  }
  for (const id of workspaces.splice(0)) {
    await asReplica(
      sql`DELETE FROM "EmailTemplate" WHERE "workspaceId" = ${id}`,
    )
    await asReplica(
      sql`DELETE FROM "MediaLibraryFile" WHERE "workspaceId" = ${id}`,
    )
    await asReplica(sql`DELETE FROM "Workspace" WHERE id = ${id}`)
  }
})

afterAll(async () => {
  if (!databaseUrl) {
    return
  }
  await db.$client.end()
})

describe.skipIf(!databaseUrl)("emailTemplateService", () => {
  test("create, get, list, update, archive, delete", async () => {
    const workspaceId = await seedWorkspace()
    const created = await emailTemplateService.create({
      workspaceId,
      data: { name: "  Welcome  ", document: DOCUMENT },
    })
    expect(created.name).toBe("Welcome")
    expect(created.status).toBe("active")
    expect(
      (await emailTemplateService.getDocument({ workspaceId, id: created.id }))
        .blocks,
    ).toHaveLength(1)

    const updated = await emailTemplateService.update({
      workspaceId,
      id: created.id,
      data: {
        name: "Welcome v2",
        document: { ...DOCUMENT, settings: { preheader: "hi" } },
      },
    })
    expect(updated.name).toBe("Welcome v2")

    await emailTemplateService.setStatus({
      workspaceId,
      id: created.id,
      status: "archived",
    })
    expect(await emailTemplateService.list({ workspaceId })).toEqual([])
    expect(
      await emailTemplateService.list({ workspaceId, includeArchived: true }),
    ).toHaveLength(1)

    await emailTemplateService.delete({ workspaceId, id: created.id })
    await expect(
      emailTemplateService.get({ workspaceId, id: created.id }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
  })

  test("an invalid document is a 422 on `document`, and nothing is stored", async () => {
    const workspaceId = await seedWorkspace()
    const bad = [
      null,
      "x",
      { ...DOCUMENT, extra: 1 },
      { ...DOCUMENT, blocks: [] },
      {
        ...DOCUMENT,
        blocks: [
          {
            id: "1",
            type: "button",
            label: "x",
            action: { kind: "url", url: "javascript:alert(1)" },
          },
        ],
      },
      {
        ...DOCUMENT,
        blocks: Array.from({ length: 20 }, (_, i) => ({
          id: String(i + 1),
          type: "html",
          html: "x".repeat(20_000),
        })),
      },
    ]
    for (const document of bad) {
      const error = await emailTemplateService
        .create({ workspaceId, data: { name: "Bad", document } })
        .catch((e: unknown) => e)
      expectValidation(error, "document")
    }
    expect(
      await emailTemplateService.list({ workspaceId, includeArchived: true }),
    ).toEqual([])
  })

  test("names: empty, too long or duplicate in the workspace is a 422 on `name`; another workspace may reuse it", async () => {
    const workspaceId = await seedWorkspace()
    const other = await seedWorkspace()
    for (const name of ["", "   ", "x".repeat(121), 42, null]) {
      const error = await emailTemplateService
        .create({ workspaceId, data: { name, document: DOCUMENT } })
        .catch((e: unknown) => e)
      expectValidation(error, "name")
    }
    await emailTemplateService.create({
      workspaceId,
      data: { name: "Same", document: DOCUMENT },
    })
    const dup = await emailTemplateService
      .create({ workspaceId, data: { name: "Same", document: DOCUMENT } })
      .catch((e: unknown) => e)
    expectValidation(dup, "name")
    await expect(
      emailTemplateService.create({
        workspaceId: other,
        data: { name: "Same", document: DOCUMENT },
      }),
    ).resolves.toMatchObject({ name: "Same" })
  })

  test("every read and write is scoped to the workspace", async () => {
    const workspaceId = await seedWorkspace()
    const other = await seedWorkspace()
    const row = await emailTemplateService.create({
      workspaceId,
      data: { name: "Mine", document: DOCUMENT },
    })
    await expect(
      emailTemplateService.get({ workspaceId: other, id: row.id }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    await expect(
      emailTemplateService.update({
        workspaceId: other,
        id: row.id,
        data: { name: "Stolen", document: DOCUMENT },
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    await expect(
      emailTemplateService.setStatus({
        workspaceId: other,
        id: row.id,
        status: "archived",
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    await expect(
      emailTemplateService.delete({ workspaceId: other, id: row.id }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    expect(
      (await emailTemplateService.get({ workspaceId, id: row.id })).name,
    ).toBe("Mine")
  })

  test("a stored document is re-validated on read (never trusted as stored)", async () => {
    const workspaceId = await seedWorkspace()
    const id = mintId()
    await asReplica(sql`
      INSERT INTO "EmailTemplate" (id, name, document, "workspaceId")
      VALUES (${id}, 'corrupt', ${JSON.stringify({ version: 1, settings: {}, blocks: [{ id: "1", type: "script" }] })}::jsonb, ${workspaceId})`)
    await expect(
      emailTemplateService.getDocument({ workspaceId, id }),
    ).rejects.toBeInstanceOf(DocumentValidationError)
  })

  test("s221b: every referenced media file must be this workspace's; a foreign, deleted or out-of-range id is a 422", async () => {
    const workspaceId = await seedWorkspace()
    const other = await seedWorkspace()
    const mine = await seedMediaFile(workspaceId)
    const mine2 = await seedMediaFile(workspaceId)
    const theirs = await seedMediaFile(other)

    const row = await emailTemplateService.create({
      workspaceId,
      data: { name: "Assets", document: withAssets(mine, mine2) },
    })
    for (const document of [
      withAssets(theirs, mine),
      withAssets(mine, theirs),
      withAssets(mine, "1"),
      withAssets("99999999999999999999", mine),
    ]) {
      const created = await emailTemplateService
        .create({ workspaceId, data: { name: "Bad assets", document } })
        .catch((e: unknown) => e)
      expectValidation(created, "document")
      const updated = await emailTemplateService
        .update({ workspaceId, id: row.id, data: { name: "Assets", document } })
        .catch((e: unknown) => e)
      expectValidation(updated, "document")
    }
    expect(
      (await emailTemplateService.getDocument({ workspaceId, id: row.id }))
        .blocks[0],
    ).toMatchObject({ asset: { fileId: mine } })
  })
})
