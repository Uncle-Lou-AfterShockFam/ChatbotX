// @vitest-environment node

/**
 * The form submission limit and availability window (s220c A2-4) against a
 * REAL Postgres: N racing web submits against a limit of L must store exactly
 * L rows. Mautic checks, then inserts, and overshoots under concurrency; the
 * negative control below shows the same race without the per-form lock does.
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, sql } from "@chatbotx.io/database/client"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"

vi.mock("@chatbotx.io/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/events")>()),
  emitFormSubmitted: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@chatbotx.io/redis", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/redis")>()),
  invalidateCacheByTags: vi.fn().mockResolvedValue(undefined),
  withCache: <T>(_key: string, fn: () => Promise<T>) => fn(),
}))
vi.mock("../../src/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { formSubmitService } = await import("../../src/form/submit")
const { formService } = await import("../../src/form/service")

const databaseUrl = requireRealDatabaseUrl()

let nextId = 9_223_000_000_000_000n + BigInt(Date.now() % 1_000_000_000) * 1000n
const mintId = (): string => {
  nextId += 1n
  return nextId.toString()
}
const seeded: Record<string, string[]> = { Form: [], Workspace: [] }

async function asReplica(statement: ReturnType<typeof sql>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`)
    await tx.execute(statement)
  })
}

/** A published, anonymous web form (one text field, maps nothing: no contacts). */
async function seedForm(settings: Record<string, unknown>) {
  const workspaceId = mintId()
  const formId = mintId()
  const slug = `limit-${formId}`
  const def = JSON.stringify({
    steps: [
      {
        id: "s1",
        fields: [{ key: "note", type: "text", label: "Note", required: true }],
      },
    ],
    rules: [],
  })
  await asReplica(sql`
    INSERT INTO "Workspace" (id, name, "ownerId") VALUES (${workspaceId}, 'a2-4', 1)`)
  seeded.Workspace?.push(workspaceId)
  await asReplica(sql`
    INSERT INTO "Form" (id, title, slug, status, definition, "publishedDefinition",
                        "definitionVersion", settings, "workspaceId")
    VALUES (${formId}, 'Limited', ${slug}, 'published', ${def}::jsonb, ${def}::jsonb, 1,
            ${JSON.stringify({ channels: ["web"], submitLimitPerIpPerHour: 1000, ...settings })}::jsonb,
            ${workspaceId})`)
  seeded.Form?.push(formId)
  return { workspaceId, formId, slug }
}

type World = Awaited<ReturnType<typeof seedForm>>

// Distinct answers and ips: no dedup, no per-ip budget in the way.
const submitMany = (w: World, n: number, from = 0) =>
  Promise.all(
    Array.from({ length: n }, (_, k) => k + from).map((i) =>
      formSubmitService.submit({
        workspaceId: w.workspaceId,
        slug: w.slug,
        values: { note: `n${i}` },
        honeypotFilled: false,
        clientIp: `198.51.100.${i + 1}`,
        userAgent: "vitest",
      }),
    ),
  )

async function rowCount(w: World): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM "FormSubmission" WHERE "formId" = ${w.formId}`)
  return rows.rows[0]?.n ?? 0
}

afterEach(async () => {
  vi.restoreAllMocks()
  if (!databaseUrl) {
    return
  }
  const forms = seeded.Form ?? []
  if (forms.length > 0) {
    await asReplica(sql`
      DELETE FROM "FormSubmission" WHERE "formId" IN (${sql.join(
        forms.map((id) => sql`${id}`),
        sql`, `,
      )})`)
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

describe.skipIf(!databaseUrl)("form submission limit (real Postgres)", () => {
  test("20 racing submits against a limit of 5 store exactly 5; the rest are closed (limit)", async () => {
    const w = await seedForm({ submissionLimit: 5, closedMessage: "Full." })
    const results = await submitMany(w, 20)
    expect(results.filter((r) => r.kind === "ok")).toHaveLength(5)
    const closed = results.filter((r) => r.kind === "closed")
    expect(closed).toHaveLength(15)
    expect(closed[0]).toEqual({
      kind: "closed",
      reason: "limit",
      message: "Full.",
    })
    expect(await rowCount(w)).toBe(5)
  })

  test("negative control: the same race WITHOUT the per-form lock overshoots the limit", async () => {
    const w = await seedForm({ submissionLimit: 5 })
    // check-then-insert (Mautic's shape), with a pause between the two so
    // every racer reads the count before any of them commits
    vi.spyOn(formSubmitService, "admit").mockImplementation(
      async (tx, formId) => {
        const n = await formSubmitService.countForForm(formId, tx)
        await new Promise((r) => setTimeout(r, 50))
        return n < 5 ? null : "limit"
      },
    )
    await submitMany(w, 20)
    expect(await rowCount(w)).toBeGreaterThan(5)
  })

  test("a deleted submission frees its place", async () => {
    const w = await seedForm({ submissionLimit: 2 })
    await submitMany(w, 2)
    expect((await submitMany(w, 1, 2))[0]?.kind).toBe("closed")
    await asReplica(sql`
      DELETE FROM "FormSubmission"
       WHERE id = (SELECT id FROM "FormSubmission" WHERE "formId" = ${w.formId} LIMIT 1)`)
    expect((await submitMany(w, 1, 3))[0]?.kind).toBe("ok")
    expect(await rowCount(w)).toBe(2)
    // an identical resubmit of a stored answer stays a duplicate, never a new row
    expect((await submitMany(w, 1, 3))[0]).toMatchObject({
      kind: "ok",
      duplicate: true,
    })
  })

  test("outside the window nothing is stored: pending before publishUp, closed from publishDown", async () => {
    const future = await seedForm({
      publishUp: new Date(Date.now() + 3_600_000).toISOString(),
      pendingMessage: "Soon.",
    })
    expect((await submitMany(future, 1))[0]).toEqual({
      kind: "closed",
      reason: "pending",
      message: "Soon.",
    })
    expect(await rowCount(future)).toBe(0)
    const past = await seedForm({
      publishDown: new Date(Date.now() - 1000).toISOString(),
    })
    expect((await submitMany(past, 1))[0]).toMatchObject({
      kind: "closed",
      reason: "closed",
    })
    expect(await rowCount(past)).toBe(0)
  })

  test("a limit saved while a submit was in flight still binds it (the admission re-reads the settings; blind probe s220c)", async () => {
    const w = await seedForm({})
    await submitMany(w, 1)
    // the submit's early read still sees "no limit"...
    const stale = await formService.findPublishedBySlug({
      workspaceId: w.workspaceId,
      slug: w.slug,
    })
    vi.spyOn(formService, "findPublishedBySlug").mockResolvedValue(stale)
    // ...while the owner has since capped the form at 1 (already reached)
    await asReplica(sql`
      UPDATE "Form" SET settings = settings || '{"submissionLimit": 1}'::jsonb WHERE id = ${w.formId}`)
    expect((await submitMany(w, 1, 1))[0]).toMatchObject({
      kind: "closed",
      reason: "limit",
    })
    expect(await rowCount(w)).toBe(1)
  })

  test("a window that closed while a submit was in flight refuses it (fresh clock + settings at admission)", async () => {
    const w = await seedForm({})
    const stale = await formService.findPublishedBySlug({
      workspaceId: w.workspaceId,
      slug: w.slug,
    })
    vi.spyOn(formService, "findPublishedBySlug").mockResolvedValue(stale)
    const closedAt = JSON.stringify({
      publishDown: new Date(Date.now() - 1000).toISOString(),
    })
    await asReplica(sql`
      UPDATE "Form" SET settings = settings || ${closedAt}::jsonb WHERE id = ${w.formId}`)
    expect((await submitMany(w, 1))[0]).toMatchObject({
      kind: "closed",
      reason: "closed",
    })
    expect(await rowCount(w)).toBe(0)
  })

  test("a lock held too long answers 'try again' (bounded wait) and stores nothing; the timeout never leaks", async () => {
    const w = await seedForm({ submissionLimit: 5 })
    const holder = await db.$client.connect()
    try {
      await holder.query("BEGIN")
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`form-limit:${w.formId}`],
      )
      const started = Date.now()
      const [r] = await submitMany(w, 1)
      expect(r).toMatchObject({ kind: "rateLimited", retryAfter: 5 })
      expect(Date.now() - started).toBeGreaterThanOrEqual(4500)
    } finally {
      await holder.query("ROLLBACK")
      holder.release()
    }
    expect(await rowCount(w)).toBe(0)
    expect((await submitMany(w, 1, 1))[0]).toMatchObject({ kind: "ok" })
  }, 20_000)
})
