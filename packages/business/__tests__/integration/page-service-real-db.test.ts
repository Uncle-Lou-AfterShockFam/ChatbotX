// @vitest-environment node

/**
 * Custom pages (B4, s227a) against a REAL Postgres: the shared document
 * rules on write, workspace scoping, idempotent per-ref links, the public
 * lookup's refusal order, the atomic view counter, the sweep, and the FK
 * cascade when the contact or page is deleted.
 *
 *     DATABASE_URL=postgres://... REQUIRE_REAL_DB=1 vitest run --dir __tests__/integration
 */

import { db, sql } from "@chatbotx.io/database/client"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"
import { verifyEmailFlowToken } from "../../src/email-topic/flow-url"

vi.mock("../../src/audit/dispatcher", () => ({
  dispatchAuditRecord: vi.fn().mockResolvedValue(undefined),
}))

const { pageService, mintPageToken } = await import("../../src/page")

const databaseUrl = requireRealDatabaseUrl()

let nextId = 9_223_100_000_000_000n
function mintId(): string {
  nextId += 1n
  return nextId.toString()
}

const workspaces: string[] = []
const HOUR_MS = 3_600_000
const FLOW_HREF = /href="(https:\/\/hub\.example\/email-topic\/flow\?t=[^"]+)"/

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
    VALUES (${id}, ${`s227a ${id}`}, 1)`)
  workspaces.push(id)
  return id
}

async function seedContact(workspaceId: string): Promise<string> {
  const id = mintId()
  await asReplica(
    sql`INSERT INTO "Contact" (id, "workspaceId") VALUES (${id}, ${workspaceId})`,
  )
  return id
}

const document = (blocks: unknown[] = []) => ({
  version: 1,
  settings: { background: "#fafafa" },
  blocks: [
    {
      id: "1",
      type: "heading",
      level: 1,
      text: "<p>Hi {{first_name|friend}}</p>",
    },
    ...blocks,
  ],
})

function expectValidation(error: unknown, field: string) {
  expect(error).toMatchObject({ httpStatusCode: 422, field })
}

afterEach(async () => {
  if (!databaseUrl) {
    return
  }
  for (const id of workspaces.splice(0)) {
    await asReplica(sql`DELETE FROM "PageLink" WHERE "workspaceId" = ${id}`)
    await asReplica(sql`DELETE FROM "Page" WHERE "workspaceId" = ${id}`)
    await asReplica(sql`DELETE FROM "Contact" WHERE "workspaceId" = ${id}`)
    await asReplica(sql`DELETE FROM "Workspace" WHERE id = ${id}`)
  }
})

afterAll(async () => {
  if (!databaseUrl) {
    return
  }
  await db.$client.end()
})

describe.skipIf(!databaseUrl)("pageService", () => {
  test("create applies the shared document rules, the TTL default and bounds", async () => {
    const workspaceId = await seedWorkspace()
    const page = await pageService.create({
      workspaceId,
      data: { name: "  Offer  ", document: document() },
    })
    expect(page).toMatchObject({
      name: "Offer",
      status: "active",
      linkTtlHours: 168,
    })

    for (const linkTtlHours of [0, 2161, 1.5, "24", Number.NaN]) {
      const error = await pageService
        .create({
          workspaceId,
          data: {
            name: `x${linkTtlHours}`,
            document: document(),
            linkTtlHours,
          },
        })
        .catch((e: unknown) => e)
      expectValidation(error, "linkTtlHours")
    }
    // Unknown key in the closed schema, a name clash, a null body.
    expectValidation(
      await pageService
        .create({
          workspaceId,
          data: { name: "y", document: { ...document(), extra: 1 } },
        })
        .catch((e: unknown) => e),
      "document",
    )
    expectValidation(
      await pageService
        .create({ workspaceId, data: { name: "Offer", document: document() } })
        .catch((e: unknown) => e),
      "name",
    )
    expectValidation(
      await pageService
        .create({ workspaceId, data: null as never })
        .catch((e: unknown) => e),
      "name",
    )
  })

  test("reads and writes are scoped to the workspace", async () => {
    const workspaceId = await seedWorkspace()
    const other = await seedWorkspace()
    const page = await pageService.create({
      workspaceId,
      data: { name: "Mine", document: document() },
    })
    await expect(
      pageService.get({ workspaceId: other, id: page.id }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    await expect(
      pageService.update({
        workspaceId: other,
        id: page.id,
        data: { name: "Stolen", document: document() },
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    const contact = await seedContact(other)
    await expect(
      pageService.mintLink({
        workspaceId: other,
        pageId: page.id,
        contactId: contact,
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    // A contact of another workspace cannot be linked to this page.
    await expect(
      pageService.mintLink({
        workspaceId,
        pageId: page.id,
        contactId: contact,
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
  })

  test("mintLink is idempotent per ref, even under concurrency", async () => {
    const workspaceId = await seedWorkspace()
    const contactId = await seedContact(workspaceId)
    const page = await pageService.create({
      workspaceId,
      data: { name: "P", document: document(), linkTtlHours: 24 },
    })
    const now = new Date("2026-09-30T12:00:00Z")
    const links = await Promise.all(
      Array.from({ length: 8 }, () =>
        pageService.mintLink({
          workspaceId,
          pageId: page.id,
          contactId,
          ref: "exec-1:step-1",
          now,
        }),
      ),
    )
    expect(new Set(links.map((link) => link.id)).size).toBe(1)
    expect(links[0].expiresAt.getTime()).toBe(now.getTime() + 24 * HOUR_MS)

    // No ref: a new link each time. A step override beats the page TTL.
    const a = await pageService.mintLink({
      workspaceId,
      pageId: page.id,
      contactId,
    })
    const b = await pageService.mintLink({
      workspaceId,
      pageId: page.id,
      contactId,
      ttlHours: 1,
      now,
    })
    expect(a.id).not.toBe(b.id)
    expect(b.expiresAt.getTime()).toBe(now.getTime() + HOUR_MS)

    // The same ref for another contact is refused, never shared.
    const stranger = await seedContact(workspaceId)
    expectValidation(
      await pageService
        .mintLink({
          workspaceId,
          pageId: page.id,
          contactId: stranger,
          ref: "exec-1:step-1",
        })
        .catch((e: unknown) => e),
      "ref",
    )
    expectValidation(
      await pageService
        .mintLink({ workspaceId, pageId: page.id, contactId, ref: "bad ref" })
        .catch((e: unknown) => e),
      "ref",
    )
    expectValidation(
      await pageService
        .mintLink({ workspaceId, pageId: page.id, contactId, ttlHours: 9999 })
        .catch((e: unknown) => e),
      "linkTtlHours",
    )
  })

  test("resolveView: invalid, unknown, expired at the boundary, archived", async () => {
    const workspaceId = await seedWorkspace()
    const contactId = await seedContact(workspaceId)
    const page = await pageService.create({
      workspaceId,
      data: { name: "V", document: document(), linkTtlHours: 1 },
    })
    const now = new Date("2026-09-30T12:00:00Z")
    const link = await pageService.mintLink({
      workspaceId,
      pageId: page.id,
      contactId,
      now,
    })

    for (const token of ["", "short", `${link.token}x`, "!".repeat(22)]) {
      expect(await pageService.resolveView({ token })).toEqual({
        ok: false,
        reason: "invalid",
      })
    }
    expect(await pageService.resolveView({ token: mintPageToken() })).toEqual({
      ok: false,
      reason: "not-found",
    })
    const justBefore = new Date(now.getTime() + HOUR_MS - 1)
    expect(
      (await pageService.resolveView({ token: link.token, now: justBefore }))
        .ok,
    ).toBe(true)
    expect(
      await pageService.resolveView({
        token: link.token,
        now: new Date(now.getTime() + HOUR_MS),
      }),
    ).toEqual({ ok: false, reason: "expired" })

    await pageService.setStatus({
      workspaceId,
      id: page.id,
      status: "archived",
    })
    expect(
      await pageService.resolveView({ token: link.token, now: justBefore }),
    ).toEqual({ ok: false, reason: "archived" })
    // An archived page mints nothing.
    expectValidation(
      await pageService
        .mintLink({ workspaceId, pageId: page.id, contactId })
        .catch((e: unknown) => e),
      "pageId",
    )
  })

  test("renderView merges the contact's values, signs flow buttons for this contact", async () => {
    const workspaceId = await seedWorkspace()
    const contactId = await seedContact(workspaceId)
    const page = await pageService.create({
      workspaceId,
      data: {
        name: "Render <me>",
        document: document([
          {
            id: "2",
            type: "button",
            label: "Start",
            action: {
              kind: "flow",
              beforeStep: {
                id: "11700000000000002",
                stepType: "startExternalFlow",
                flowId: "11700000000000001",
              },
              steps: [],
            },
          },
          {
            id: "3",
            type: "text",
            text: '<p><a href="javascript:alert(1)">x</a>{{evil}}</p>',
          },
        ]),
      },
    })
    const contactInboxId = "11700000000000009"
    const link = await pageService.mintLink({
      workspaceId,
      pageId: page.id,
      contactId,
    })
    const view = await pageService.resolveView({ token: link.token })
    if (!view.ok) {
      throw new Error("expected a view")
    }
    const asked: string[][] = []
    const { html, missing } = await pageService.renderView({
      view: { ...view, link: { ...view.link, contactInboxId } },
      appUrl: "https://hub.example",
      resolveVariables: (keys) => {
        asked.push(keys)
        return Promise.resolve({
          first_name: "Ada",
          evil: "<script>x</script>",
        })
      },
    })
    expect(asked.map((keys) => keys.toSorted())).toEqual([
      ["evil", "first_name"],
    ])
    expect(html).toContain("Hi Ada")
    expect(html).toContain("<title>Render &lt;me&gt;</title>")
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("javascript:")
    expect(missing).toEqual([])
    const href = FLOW_HREF.exec(html)?.[1]
    expect(href).toBeDefined()
    const sealed = new URL(
      (href as string).replaceAll("&amp;", "&"),
    ).searchParams.get("t") as string
    expect(await verifyEmailFlowToken(sealed)).toMatchObject({
      wid: workspaceId,
      fid: "11700000000000001",
      cid: contactId,
      ciid: contactInboxId,
    })

    // Without a contact inbox a flow button renders nothing (no dead link).
    const bare = await pageService.renderView({
      view,
      appUrl: "https://hub.example",
      resolveVariables: async () => ({}),
    })
    expect(bare.html).not.toContain("email-topic/flow")
    expect(bare.html).toContain("Hi friend")
  })

  test("recordView counts every concurrent view", async () => {
    const workspaceId = await seedWorkspace()
    const contactId = await seedContact(workspaceId)
    const page = await pageService.create({
      workspaceId,
      data: { name: "C", document: document() },
    })
    const link = await pageService.mintLink({
      workspaceId,
      pageId: page.id,
      contactId,
    })
    const first = new Date("2026-09-30T12:00:00Z")
    await pageService.recordView({ linkId: link.id, now: first })
    await Promise.all(
      Array.from({ length: 10 }, () =>
        pageService.recordView({ linkId: link.id }),
      ),
    )
    const [row] = await db
      .execute<{
        viewCount: number
        firstViewedAt: Date
      }>(
        sql`SELECT "viewCount", "firstViewedAt" FROM "PageLink" WHERE id = ${link.id}`,
      )
      .then((result) => result.rows)
    expect(row.viewCount).toBe(11)
    expect(new Date(row.firstViewedAt).getTime()).toBe(first.getTime())
  })

  test("contact and page deletes cascade to links; the sweep keeps 30 days", async () => {
    const workspaceId = await seedWorkspace()
    const contactId = await seedContact(workspaceId)
    const keepContact = await seedContact(workspaceId)
    const page = await pageService.create({
      workspaceId,
      data: { name: "D", document: document() },
    })
    const gone = await pageService.mintLink({
      workspaceId,
      pageId: page.id,
      contactId,
    })
    await db.execute(sql`DELETE FROM "Contact" WHERE id = ${contactId}`)
    expect(await pageService.resolveView({ token: gone.token })).toEqual({
      ok: false,
      reason: "not-found",
    })

    const now = new Date("2026-09-30T12:00:00Z")
    const old = await pageService.mintLink({
      workspaceId,
      pageId: page.id,
      contactId: keepContact,
      ttlHours: 1,
      now: new Date(now.getTime() - 31 * 24 * HOUR_MS),
    })
    const recent = await pageService.mintLink({
      workspaceId,
      pageId: page.id,
      contactId: keepContact,
      ttlHours: 1,
      now: new Date(now.getTime() - 29 * 24 * HOUR_MS),
    })
    // Other suites' rows may be due too: sweep in small batches until done.
    let swept = 0
    for (let n = 1; n > 0; ) {
      n = await pageService.sweepExpired({ now, batch: 2 })
      swept += n
    }
    expect(swept).toBeGreaterThanOrEqual(1)
    expect(await pageService.resolveView({ token: old.token })).toEqual({
      ok: false,
      reason: "not-found",
    })
    expect(await pageService.resolveView({ token: recent.token, now })).toEqual(
      {
        ok: false,
        reason: "expired",
      },
    )

    await pageService.delete({ workspaceId, id: page.id })
    expect(await pageService.resolveView({ token: recent.token, now })).toEqual(
      {
        ok: false,
        reason: "not-found",
      },
    )
  })
})
