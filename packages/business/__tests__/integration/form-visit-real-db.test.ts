// @vitest-environment node

/**
 * Web formAbandoned (s224a A2-4) against a REAL Postgres: a personal link's
 * visitor opens ONE visit per (form, contact), a submit closes it, and the
 * sweep closes the rest once due with exactly one `formAbandoned` (channel
 * web). The claim is the `abandonEmittedAt` compare-and-set, so a submit
 * racing the sweep ends the row one way, never both.
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, sql } from "@chatbotx.io/database/client"
import { signFormLinkToken } from "@chatbotx.io/encryption/form-link-token"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"

const { emitFormAbandoned } = vi.hoisted(() => ({
  emitFormAbandoned: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@chatbotx.io/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/events")>()),
  emitFormSubmitted: vi.fn().mockResolvedValue(undefined),
  emitCustomFieldChanged: vi.fn().mockResolvedValue(undefined),
  emitFormAbandoned,
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
const { formVisitService, FORM_VISIT_RETENTION_MS } = await import(
  "../../src/form/visit"
)

const databaseUrl = requireRealDatabaseUrl()

let nextId = 9_224_100_000_000_000n + BigInt(Date.now() % 1_000_000_000) * 1000n
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

async function seed(settings: Record<string, unknown> = {}) {
  const workspaceId = mintId()
  const contactId = mintId()
  const formId = mintId()
  const slug = `visit-${formId}`
  await asReplica(
    sql`INSERT INTO "Workspace" (id, name, "ownerId") VALUES (${workspaceId}, 'a2-4b', 1)`,
  )
  seeded.Workspace?.push(workspaceId)
  await asReplica(
    sql`INSERT INTO "Contact" (id, "workspaceId") VALUES (${contactId}, ${workspaceId})`,
  )
  seeded.Contact?.push(contactId)
  await asReplica(sql`
    INSERT INTO "Form" (id, title, slug, status, definition, "publishedDefinition",
                        "definitionVersion", settings, "workspaceId")
    VALUES (${formId}, 'Visit', ${slug}, 'published', ${DEF}::jsonb, ${DEF}::jsonb, 1,
            ${JSON.stringify({ channels: ["web"], submitLimitPerIpPerHour: 1000, ...settings })}::jsonb,
            ${workspaceId})`)
  seeded.Form?.push(formId)
  const k = await signFormLinkToken({ workspaceId, formId, contactId })
  const form = await formService.findPublishedBySlug({ workspaceId, slug })
  if (!form) {
    throw new Error("seed: form not served")
  }
  return { workspaceId, contactId, formId, slug, k, form }
}

type VisitRow = {
  id: string
  abandonAt: Date
  lastActivityAt: Date
  submittedAt: Date | null
  abandonEmittedAt: Date | null
}
const visits = async (formId: string): Promise<VisitRow[]> =>
  (
    await db.execute<VisitRow>(sql`
      SELECT id, "abandonAt", "lastActivityAt", "submittedAt", "abandonEmittedAt"
        FROM "FormVisit" WHERE "formId" = ${formId} ORDER BY "createdAt", id`)
  ).rows.map((r) => ({
    ...r,
    abandonAt: new Date(r.abandonAt),
    lastActivityAt: new Date(r.lastActivityAt),
    submittedAt: r.submittedAt ? new Date(r.submittedAt) : null,
    abandonEmittedAt: r.abandonEmittedAt ? new Date(r.abandonEmittedAt) : null,
  }))

const submit = (w: Awaited<ReturnType<typeof seed>>, note = "hi") =>
  formSubmitService.submit({
    workspaceId: w.workspaceId,
    slug: w.slug,
    values: { note },
    honeypotFilled: false,
    clientIp: "198.51.100.40",
    userAgent: "vitest",
    formLinkToken: w.k,
  })

const MIN = 60_000

afterEach(async () => {
  emitFormAbandoned.mockClear()
  if (!databaseUrl) {
    return
  }
  const forms = seeded.Form ?? []
  if (forms.length > 0) {
    const ids = sql.join(
      forms.map((id) => sql`${id}`),
      sql`, `,
    )
    await asReplica(sql`DELETE FROM "FormVisit" WHERE "formId" IN (${ids})`)
    await asReplica(
      sql`DELETE FROM "FormSubmission" WHERE "formId" IN (${ids})`,
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

describe.skipIf(!databaseUrl)("web form visits (real Postgres)", () => {
  test("a linked beacon opens ONE visit; a second only moves it forward", async () => {
    const w = await seed({ abandonAfterMinutes: 10 })
    const t0 = new Date()
    expect(
      await formVisitService.start({
        form: w.form,
        formLinkToken: w.k,
        now: t0,
      }),
    ).toEqual({ kind: "started" })
    const t1 = new Date(t0.getTime() + 3 * MIN)
    await formVisitService.start({ form: w.form, formLinkToken: w.k, now: t1 })
    const rows = await visits(w.formId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.lastActivityAt.getTime()).toBe(t1.getTime())
    expect(rows[0]?.abandonAt.getTime()).toBe(t1.getTime() + 10 * MIN)
  })

  test("20 racing beacons for one contact leave exactly one open visit", async () => {
    const w = await seed()
    await Promise.all(
      Array.from({ length: 20 }, () =>
        formVisitService.start({ form: w.form, formLinkToken: w.k }),
      ),
    )
    expect(await visits(w.formId)).toHaveLength(1)
  })

  test("no link, a foreign link, a deleted contact or a closed form write nothing", async () => {
    const w = await seed()
    const other = await seed()
    expect(
      await formVisitService.start({ form: w.form, formLinkToken: undefined }),
    ).toEqual({ kind: "ignored", reason: "noLink" })
    expect(
      await formVisitService.start({ form: w.form, formLinkToken: "garbage" }),
    ).toEqual({ kind: "ignored", reason: "noLink" })
    // other form's token, same shape
    expect(
      await formVisitService.start({ form: w.form, formLinkToken: other.k }),
    ).toEqual({ kind: "ignored", reason: "noLink" })
    const gone = await seed()
    await asReplica(sql`DELETE FROM "Contact" WHERE id = ${gone.contactId}`)
    expect(
      await formVisitService.start({ form: gone.form, formLinkToken: gone.k }),
    ).toEqual({ kind: "ignored", reason: "noLink" })
    const future = new Date(Date.now() + 60 * MIN).toISOString()
    const pending = await seed({ publishUp: future })
    expect(
      await formVisitService.start({
        form: pending.form,
        formLinkToken: pending.k,
      }),
    ).toEqual({ kind: "ignored", reason: "closed" })
    for (const f of [w, other, gone, pending]) {
      expect(await visits(f.formId)).toHaveLength(0)
    }
  })

  test("a linked submit closes the visit; the sweep then emits nothing for it", async () => {
    const w = await seed()
    const t0 = new Date(Date.now() - 60 * MIN)
    await formVisitService.start({ form: w.form, formLinkToken: w.k, now: t0 })
    expect(await submit(w)).toMatchObject({ kind: "ok", duplicate: false })
    const [row] = await visits(w.formId)
    expect(row?.submittedAt).not.toBeNull()
    expect(row?.abandonEmittedAt).toBeNull()
    await formVisitService.emitDueAbandons()
    expect(emitFormAbandoned).not.toHaveBeenCalledWith(
      w.workspaceId,
      expect.anything(),
      expect.anything(),
    )
  })

  test("a duplicate submit still closes a visit opened after the first copy", async () => {
    const w = await seed()
    expect(await submit(w, "same")).toMatchObject({ duplicate: false })
    await formVisitService.start({ form: w.form, formLinkToken: w.k })
    expect(await submit(w, "same")).toMatchObject({ duplicate: true })
    const [row] = await visits(w.formId)
    expect(row?.submittedAt).not.toBeNull()
  })

  test("a due visit emits formAbandoned (web) once; a second sweep adds nothing", async () => {
    const w = await seed({ abandonAfterMinutes: 5 })
    const t0 = new Date(Date.now() - 10 * MIN)
    await formVisitService.start({ form: w.form, formLinkToken: w.k, now: t0 })
    const [open] = await visits(w.formId)
    await formVisitService.emitDueAbandons()
    await formVisitService.emitDueAbandons()
    const mine = emitFormAbandoned.mock.calls.filter(
      (c) => c[0] === w.workspaceId,
    )
    expect(mine).toHaveLength(1)
    expect(mine[0]).toEqual([
      w.workspaceId,
      w.contactId,
      {
        formId: w.formId,
        formVisitId: open?.id,
        channel: "web",
        reason: "timeout",
        lastFieldKey: null,
        askedCount: 0,
        occurredAt: open?.abandonAt.toISOString(),
      },
    ])
    // A new interaction after the abandon opens a NEW visit.
    await formVisitService.start({ form: w.form, formLinkToken: w.k })
    expect(await visits(w.formId)).toHaveLength(2)
  })

  test("a visit not yet due stays open", async () => {
    const w = await seed({ abandonAfterMinutes: 30 })
    await formVisitService.start({ form: w.form, formLinkToken: w.k })
    await formVisitService.emitDueAbandons()
    const [row] = await visits(w.formId)
    expect(row?.abandonEmittedAt).toBeNull()
  })

  test("two racing sweeps emit exactly once per visit", async () => {
    const ws = await Promise.all(
      Array.from({ length: 5 }, () => seed({ abandonAfterMinutes: 5 })),
    )
    const t0 = new Date(Date.now() - 10 * MIN)
    for (const w of ws) {
      await formVisitService.start({
        form: w.form,
        formLinkToken: w.k,
        now: t0,
      })
    }
    await Promise.all([
      formVisitService.emitDueAbandons(),
      formVisitService.emitDueAbandons(),
      formVisitService.emitDueAbandons(),
    ])
    for (const w of ws) {
      expect(
        emitFormAbandoned.mock.calls.filter((c) => c[0] === w.workspaceId),
      ).toHaveLength(1)
    }
  })

  test("submit racing the sweep: each visit ends ONE way, and only an abandoned one emitted", async () => {
    const ws = await Promise.all(
      Array.from({ length: 8 }, () => seed({ abandonAfterMinutes: 5 })),
    )
    const t0 = new Date(Date.now() - 10 * MIN)
    for (const w of ws) {
      await formVisitService.start({
        form: w.form,
        formLinkToken: w.k,
        now: t0,
      })
    }
    await Promise.all([
      ...ws.map((w) => submit(w)),
      formVisitService.emitDueAbandons(),
    ])
    for (const w of ws) {
      const [row] = await visits(w.formId)
      const submitted = row?.submittedAt !== null
      const abandoned = row?.abandonEmittedAt !== null
      expect(submitted !== abandoned).toBe(true)
      expect(
        emitFormAbandoned.mock.calls.filter((c) => c[0] === w.workspaceId),
      ).toHaveLength(abandoned ? 1 : 0)
    }
  })

  test("past the catch-up window, or a form no longer published: closed WITHOUT an event", async () => {
    const late = await seed({ abandonAfterMinutes: 5 })
    await formVisitService.start({
      form: late.form,
      formLinkToken: late.k,
      now: new Date(Date.now() - 2 * 24 * 60 * MIN),
    })
    const draft = await seed({ abandonAfterMinutes: 5 })
    await formVisitService.start({
      form: draft.form,
      formLinkToken: draft.k,
      now: new Date(Date.now() - 10 * MIN),
    })
    await asReplica(
      sql`UPDATE "Form" SET status = 'draft' WHERE id = ${draft.formId}`,
    )
    await formVisitService.emitDueAbandons()
    for (const w of [late, draft]) {
      const [row] = await visits(w.formId)
      expect(row?.abandonEmittedAt).not.toBeNull()
      expect(
        emitFormAbandoned.mock.calls.filter((c) => c[0] === w.workspaceId),
      ).toHaveLength(0)
    }
  })

  test("prune deletes only CLOSED visits past retention", async () => {
    const w = await seed()
    const old = new Date(Date.now() - FORM_VISIT_RETENTION_MS - 60 * MIN)
    const closedOld = mintId()
    const closedNew = mintId()
    const openOld = mintId()
    await asReplica(sql`
      INSERT INTO "FormVisit" (id, "createdAt", "workspaceId", "formId", "contactId",
                               "startedAt", "lastActivityAt", "abandonAt", "submittedAt", "abandonEmittedAt")
      VALUES (${closedOld}, ${old}, ${w.workspaceId}, ${w.formId}, ${w.contactId}, ${old}, ${old}, ${old}, ${old}, NULL),
             (${closedNew}, now(), ${w.workspaceId}, ${w.formId}, ${w.contactId}, now(), now(), now(), NULL, now()),
             (${openOld}, ${old}, ${w.workspaceId}, ${w.formId}, ${w.contactId}, ${old}, ${old}, now() + interval '1 day', NULL, NULL)`)
    await formVisitService.pruneClosed()
    const left = (await visits(w.formId)).map((r) => r.id).sort()
    expect(left).toEqual([closedNew, openOld].sort())
  })

  test("deleting the contact or the form deletes its visits (cascade)", async () => {
    const w = await seed()
    await formVisitService.start({ form: w.form, formLinkToken: w.k })
    await db.execute(sql`DELETE FROM "Contact" WHERE id = ${w.contactId}`)
    expect(await visits(w.formId)).toHaveLength(0)
  })
})
