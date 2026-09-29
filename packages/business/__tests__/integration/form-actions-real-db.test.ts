// @vitest-environment node

/**
 * The form-action catalogue (s220 A2-3) against a REAL Postgres: points added
 * by concurrent submissions must sum (a lost increment is database
 * behaviour a mock cannot show), and the generalised Notification table
 * keeps one bell row per (submission, user) and exactly one subject.
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, sql } from "@chatbotx.io/database/client"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"

vi.mock("@chatbotx.io/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/events")>()),
  emitCustomFieldChanged: vi.fn().mockResolvedValue(undefined),
  emitTagRemoved: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@chatbotx.io/redis", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/redis")>()),
  invalidateCacheByTags: vi.fn().mockResolvedValue(undefined),
  withCache: <T>(_key: string, fn: () => Promise<T>) => fn(),
}))

// Action failures are logged and swallowed: collect them so a test can
// assert none happened (a starved pool once failed all ten silently).
const warned = vi.hoisted(() => [] as string[])
vi.mock("../../src/logger", () => ({
  logger: {
    warn: (o: { err?: { message?: string } }, m: string) => {
      warned.push(`${m}: ${o.err?.message ?? ""}`)
    },
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))
const { runFormActions } = await import("../../src/form/actions")

const databaseUrl = requireRealDatabaseUrl()

let nextId = 9_222_000_000_000_000n + BigInt(Date.now() % 1_000_000_000) * 1000n
const mintId = (): string => {
  nextId += 1n
  return nextId.toString()
}
const seeded: Record<string, string[]> = {
  Notification: [],
  FormSubmission: [],
  ContactCustomField: [],
  CustomField: [],
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

async function seedWorld() {
  const workspaceId = mintId()
  const contactId = mintId()
  const fieldId = mintId()
  const formId = mintId()
  await asReplica(sql`
    INSERT INTO "Workspace" (id, name, "ownerId") VALUES (${workspaceId}, 'a2-3', 1)`)
  seeded.Workspace?.push(workspaceId)
  await asReplica(sql`
    INSERT INTO "Contact" (id, "workspaceId") VALUES (${contactId}, ${workspaceId})`)
  seeded.Contact?.push(contactId)
  await asReplica(sql`
    INSERT INTO "CustomField" (id, name, type, "workspaceId")
    VALUES (${fieldId}, ${`score_${fieldId}`}, 'number', ${workspaceId})`)
  seeded.CustomField?.push(fieldId)
  await asReplica(sql`
    INSERT INTO "Form" (id, title, slug, status, definition, "definitionVersion", settings, "workspaceId")
    VALUES (${formId}, 'Scored', ${`scored-${formId}`}, 'published',
            '{"steps":[],"rules":[]}'::jsonb, 1, '{}'::jsonb, ${workspaceId})`)
  seeded.Form?.push(formId)
  return { workspaceId, contactId, fieldId, formId }
}

type World = Awaited<ReturnType<typeof seedWorld>>

const submission = (w: World, score: number | null) =>
  ({
    id: mintId(),
    workspaceId: w.workspaceId,
    formId: w.formId,
    contactId: w.contactId,
    score,
  }) as never

async function fieldValue(w: World): Promise<string | null> {
  const rows = await db.execute<{ value: string }>(sql`
    SELECT value FROM "ContactCustomField"
     WHERE "contactId" = ${w.contactId} AND "customFieldId" = ${w.fieldId}`)
  return rows.rows[0]?.value ?? null
}

afterEach(async () => {
  warned.length = 0
  if (!databaseUrl) {
    return
  }
  const contacts = seeded.Contact ?? []
  if (contacts.length > 0) {
    const list = sql.join(
      contacts.map((id) => sql`${id}`),
      sql`, `,
    )
    await asReplica(
      sql`DELETE FROM "ContactCustomField" WHERE "contactId" IN (${list})`,
    )
  }
  for (const table of Object.keys(seeded)) {
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

describe.skipIf(!databaseUrl)("form actions (real Postgres)", () => {
  test("ten submissions racing on an EMPTY points field: the score sums, none lost", async () => {
    const w = await seedWorld()
    const notify = vi.fn(async () => undefined)
    await Promise.all(
      Array.from({ length: 10 }, () =>
        runFormActions({
          db,
          workspaceId: w.workspaceId,
          contactId: w.contactId,
          form: {
            id: w.formId,
            title: "Scored",
            actions: [{ type: "addPoints", customFieldId: w.fieldId }],
          },
          submission: submission(w, 3),
          notify,
        }),
      ),
    )
    expect(warned).toEqual([])
    expect(Number(await fieldValue(w))).toBe(30)
    expect(notify).not.toHaveBeenCalled()
  })

  test("a negative score subtracts; a zero / unscored submission writes nothing", async () => {
    const w = await seedWorld()
    const run = (score: number | null) =>
      runFormActions({
        db,
        workspaceId: w.workspaceId,
        contactId: w.contactId,
        form: {
          id: w.formId,
          title: "Scored",
          actions: [{ type: "addPoints", customFieldId: w.fieldId }],
        },
        submission: submission(w, score),
        notify: vi.fn(),
      })
    await run(null)
    await run(0)
    expect(await fieldValue(w)).toBeNull()
    await run(5)
    await run(-2)
    expect(Number(await fieldValue(w))).toBe(3)
  })

  test("no deadlock with a writer that holds the field row and then touches the contact's FK (Codex probe)", async () => {
    const w = await seedWorld()
    const otherField = mintId()
    await asReplica(sql`
      INSERT INTO "CustomField" (id, name, type, "workspaceId")
      VALUES (${otherField}, ${`other_${otherField}`}, 'shortText', ${w.workspaceId})`)
    seeded.CustomField?.push(otherField)
    await asReplica(sql`
      INSERT INTO "ContactCustomField" (id, value, "contactId", "customFieldId")
      VALUES (${mintId()}, '1', ${w.contactId}, ${w.fieldId})`)
    let holding: () => void = () => undefined
    const bHolds = new Promise<void>((resolve) => {
      holding = resolve
    })
    // B: a submission-like writer: updates the points row, then inserts a
    // child of the same contact (FK check = KEY SHARE on the Contact row).
    const b = db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE "ContactCustomField" SET value = '10'
         WHERE "contactId" = ${w.contactId} AND "customFieldId" = ${w.fieldId}`)
      holding()
      await new Promise((resolve) => setTimeout(resolve, 300))
      await tx.execute(sql`
        INSERT INTO "ContactCustomField" (id, value, "contactId", "customFieldId")
        VALUES (${mintId()}, 'x', ${w.contactId}, ${otherField})`)
    })
    await bHolds
    const a = runFormActions({
      db,
      workspaceId: w.workspaceId,
      contactId: w.contactId,
      form: {
        id: w.formId,
        title: "Scored",
        actions: [{ type: "addPoints", customFieldId: w.fieldId }],
      },
      submission: submission(w, 3),
      notify: vi.fn(),
    })
    await Promise.all([a, b])
    expect(warned).toEqual([])
    expect(Number(await fieldValue(w))).toBe(13)
  })

  test("Notification: one row per (submission, user); exactly one subject", async () => {
    const w = await seedWorld()
    const submissionId = mintId()
    await asReplica(sql`
      INSERT INTO "FormSubmission" (id, "definitionVersion", values, visibility, "workspaceId", "formId", channel)
      VALUES (${submissionId}, 1, '{}'::jsonb, '{}'::jsonb, ${w.workspaceId}, ${w.formId}, 'chat')`)
    seeded.FormSubmission?.push(submissionId)
    const insert = (
      id: string,
      dealId: string | null,
      formSubmissionId: string | null,
    ) =>
      asReplica(sql`
        INSERT INTO "Notification" (id, type, payload, "workspaceId", "userId", "dealId", "formSubmissionId")
        VALUES (${id}, 'formSubmitted', '{}'::jsonb, ${w.workspaceId}, 1, ${dealId}, ${formSubmissionId})`)
    const first = mintId()
    await insert(first, null, submissionId)
    seeded.Notification?.push(first)
    await expect(insert(mintId(), null, submissionId)).rejects.toThrow()
    await expect(insert(mintId(), null, null)).rejects.toThrow()
    await expect(insert(mintId(), "1", submissionId)).rejects.toThrow()
  })
})
