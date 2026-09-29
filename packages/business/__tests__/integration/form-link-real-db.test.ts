// @vitest-environment node

/**
 * Signed form links (s220c A2-4) against a REAL Postgres: personalLink mints a
 * link only for a form the public page serves, and a submit carrying that
 * link's token lands on the linked contact without any phone / email lookup.
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, sql } from "@chatbotx.io/database/client"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"

vi.mock("@chatbotx.io/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/events")>()),
  emitFormSubmitted: vi.fn().mockResolvedValue(undefined),
  emitCustomFieldChanged: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@chatbotx.io/redis", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/redis")>()),
  invalidateCacheByTags: vi.fn().mockResolvedValue(undefined),
  withCache: <T>(_key: string, fn: () => Promise<T>) => fn(),
}))
vi.mock("../../src/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { formService } = await import("../../src/form/service")
const { formSubmitService } = await import("../../src/form/submit")

const databaseUrl = requireRealDatabaseUrl()
const APP = "https://chat.example.org"

let nextId = 9_224_000_000_000_000n + BigInt(Date.now() % 1_000_000_000) * 1000n
const mintId = (): string => {
  nextId += 1n
  return nextId.toString()
}
const seeded: Record<string, string[]> = {
  Form: [],
  Contact: [],
  Workspace: [],
}

async function asReplica(statement: ReturnType<typeof sql>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`)
    await tx.execute(statement)
  })
}

const DEF = JSON.stringify({
  steps: [
    {
      id: "s1",
      fields: [{ key: "note", type: "text", label: "Note", required: true }],
    },
  ],
  rules: [],
})

async function seed(opts: { status?: string; channels?: string[] } = {}) {
  const workspaceId = mintId()
  const contactId = mintId()
  const formId = mintId()
  const slug = `link-${formId}`
  await asReplica(
    sql`INSERT INTO "Workspace" (id, name, "ownerId") VALUES (${workspaceId}, 'a2-4', 1)`,
  )
  seeded.Workspace?.push(workspaceId)
  await asReplica(
    sql`INSERT INTO "Contact" (id, "workspaceId") VALUES (${contactId}, ${workspaceId})`,
  )
  seeded.Contact?.push(contactId)
  await asReplica(sql`
    INSERT INTO "Form" (id, title, slug, status, definition, "publishedDefinition",
                        "definitionVersion", settings, "workspaceId")
    VALUES (${formId}, 'Linked', ${slug}, ${opts.status ?? "published"}, ${DEF}::jsonb, ${DEF}::jsonb, 1,
            ${JSON.stringify({ channels: opts.channels ?? ["web"], submitLimitPerIpPerHour: 1000 })}::jsonb,
            ${workspaceId})`)
  seeded.Form?.push(formId)
  return { workspaceId, contactId, formId, slug }
}

afterEach(async () => {
  if (!databaseUrl) {
    return
  }
  const forms = seeded.Form ?? []
  if (forms.length > 0) {
    await asReplica(
      sql`DELETE FROM "FormSubmission" WHERE "formId" IN (${sql.join(
        forms.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )
  }
  for (const table of Object.keys(seeded)) {
    const ids = seeded[table]?.splice(0) ?? []
    if (ids.length > 0) {
      await asReplica(
        sql`DELETE FROM ${sql.identifier(table)} WHERE id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      )
    }
  }
})

afterAll(async () => {
  if (databaseUrl) {
    await db.$client.end()
  }
})

describe.skipIf(!databaseUrl)("signed form links (real Postgres)", () => {
  test("a link minted for a contact lands that contact's submission on it (no lookup, no identity typed)", async () => {
    const w = await seed()
    const url = await formService.personalLink({ ...w, appUrl: APP })
    expect(url?.startsWith(`${APP}/forms/${w.workspaceId}/${w.slug}?k=`)).toBe(
      true,
    )
    const k = new URL(url as string).searchParams.get("k") as string
    const r = await formSubmitService.submit({
      workspaceId: w.workspaceId,
      slug: w.slug,
      values: { note: "hi" },
      honeypotFilled: false,
      clientIp: "198.51.100.7",
      userAgent: "vitest",
      formLinkToken: k,
    })
    expect(r).toMatchObject({ kind: "ok", contactId: w.contactId })
  })

  test("a linked submission never overwrites the contact, even on an overwriteExisting form (skeptic + blind probe s220c)", async () => {
    const w = await seed()
    const def = JSON.stringify({
      steps: [
        {
          id: "s1",
          fields: [
            {
              key: "email",
              type: "email",
              label: "Email",
              required: true,
              mapTo: { kind: "system", key: "email" },
            },
            {
              key: "first",
              type: "text",
              label: "First",
              mapTo: { kind: "system", key: "firstName" },
            },
          ],
        },
      ],
      rules: [],
    })
    await asReplica(sql`
      UPDATE "Form" SET definition = ${def}::jsonb, "publishedDefinition" = ${def}::jsonb,
             settings = settings || '{"overwriteExisting": true}'::jsonb
       WHERE id = ${w.formId}`)
    await asReplica(sql`
      UPDATE "Contact" SET email = 'owner@example.com', "firstName" = 'Owner' WHERE id = ${w.contactId}`)
    const url = await formService.personalLink({ ...w, appUrl: APP })
    const k = new URL(url as string).searchParams.get("k") as string
    const r = await formSubmitService.submit({
      workspaceId: w.workspaceId,
      slug: w.slug,
      values: { email: "attacker@example.com", first: "Mallory" },
      honeypotFilled: false,
      clientIp: "198.51.100.9",
      userAgent: "vitest",
      formLinkToken: k,
    })
    expect(r).toMatchObject({ kind: "ok", contactId: w.contactId })
    const rows = await db.execute<{ email: string; firstName: string }>(sql`
      SELECT email, "firstName" FROM "Contact" WHERE id = ${w.contactId}`)
    expect(rows.rows[0]).toEqual({
      email: "owner@example.com",
      firstName: "Owner",
    })
  })

  test("the same token on ANOTHER form of the workspace is an anonymous submission", async () => {
    const a = await seed()
    const url = await formService.personalLink({ ...a, appUrl: APP })
    const k = new URL(url as string).searchParams.get("k") as string
    const b = await seed()
    const r = await formSubmitService.submit({
      workspaceId: b.workspaceId,
      slug: b.slug,
      values: { note: "hi" },
      honeypotFilled: false,
      clientIp: "198.51.100.8",
      userAgent: "vitest",
      formLinkToken: k,
    })
    expect(r).toMatchObject({ kind: "ok", contactId: null })
  })

  test("no link for a form the page would not serve: draft, chat-only, unknown", async () => {
    const draft = await seed({ status: "draft" })
    expect(await formService.personalLink({ ...draft, appUrl: APP })).toBeNull()
    const chat = await seed({ channels: ["chat"] })
    expect(await formService.personalLink({ ...chat, appUrl: APP })).toBeNull()
    expect(
      await formService.personalLink({
        ...draft,
        formId: mintId(),
        appUrl: APP,
      }),
    ).toBeNull()
  })
})
