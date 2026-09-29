// @vitest-environment node

/**
 * The form chat run (s219 A2-2), against a REAL Postgres: the row lock, the
 * askMarker / lastAnsweredMessageId dedupe, the one-run-per-contact index,
 * the expiry sweep racing an answer, the one-submission-per-run unique key
 * and the web CHECK constraint are all database behaviour a mock cannot
 * prove. Run with
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, sql } from "@chatbotx.io/database/client"
import { createId } from "@chatbotx.io/utils"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"

const emitted = vi.hoisted(() => ({ formSubmitted: [] as unknown[] }))
vi.mock("@chatbotx.io/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/events")>()),
  emitFormSubmitted: vi.fn((...args: unknown[]) => {
    emitted.formSubmitted.push(args)
    return Promise.resolve()
  }),
  emitCustomFieldChanged: vi.fn().mockResolvedValue(undefined),
}))

// Contact writes invalidate the Redis contact cache; there is no Redis here.
vi.mock("@chatbotx.io/redis", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/redis")>()),
  invalidateCacheByTags: vi.fn().mockResolvedValue(undefined),
  withCache: <T>(_key: string, fn: () => Promise<T>) => fn(),
}))

const { formSessionService } = await import("../../src/form/session")

const databaseUrl = requireRealDatabaseUrl()

/** Own range, offset per run so a crashed run's leftovers never collide. */
let nextId = 9_221_000_000_000_000n + BigInt(Date.now() % 1_000_000_000) * 1000n
function mintId(): string {
  nextId += 1n
  return nextId.toString()
}

const seeded: Record<string, string[]> = {
  FormSubmission: [],
  FormSession: [],
  Form: [],
  Conversation: [],
  Flow: [],
  Contact: [],
  Workspace: [],
}

async function asReplica(statement: ReturnType<typeof sql>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`)
    await tx.execute(statement)
  })
}

const DEFINITION = {
  steps: [
    {
      id: "s1",
      title: "",
      fields: [
        { key: "hello", type: "paragraph", label: "Hi!", required: false },
        {
          key: "name",
          type: "text",
          label: "Name?",
          required: true,
          mapTo: { kind: "system", key: "firstName" },
        },
        {
          key: "color",
          type: "select",
          label: "Color?",
          required: true,
          options: [
            { value: "red", label: "Red", points: 2 },
            { value: "blue", label: "Blue", points: 5 },
          ],
        },
        {
          key: "email",
          type: "email",
          label: "Email?",
          required: true,
          mapTo: { kind: "system", key: "email" },
          profile: { showWhenKnown: false },
        },
        { key: "notes", type: "textarea", label: "Notes?", required: false },
      ],
    },
  ],
  rules: [],
}

type World = {
  workspaceId: string
  contactId: string
  conversationId: string
  flowId: string
  formId: string
}

async function seedWorld(
  props: { contactEmail?: string; channels?: string[] } = {},
): Promise<World> {
  const workspaceId = mintId()
  const contactId = mintId()
  const conversationId = mintId()
  const flowId = mintId()
  const formId = mintId()
  await asReplica(sql`
    INSERT INTO "Workspace" (id, name, "ownerId") VALUES (${workspaceId}, 'a2-2', 1)`)
  seeded.Workspace?.push(workspaceId)
  await asReplica(sql`
    INSERT INTO "Contact" (id, "workspaceId", email)
    VALUES (${contactId}, ${workspaceId}, ${props.contactEmail ?? null})`)
  seeded.Contact?.push(contactId)
  await asReplica(sql`
    INSERT INTO "Conversation" (id, "workspaceId", "contactId")
    VALUES (${conversationId}, ${workspaceId}, ${contactId})`)
  seeded.Conversation?.push(conversationId)
  await asReplica(sql`
    INSERT INTO "Flow" (id, name, "workspaceId") VALUES (${flowId}, 'a2-2', ${workspaceId})`)
  seeded.Flow?.push(flowId)
  const settings = JSON.stringify({ channels: props.channels ?? ["chat"] })
  const def = JSON.stringify(DEFINITION)
  await asReplica(sql`
    INSERT INTO "Form" (id, title, slug, status, definition, "publishedDefinition",
                        "definitionVersion", settings, "workspaceId")
    VALUES (${formId}, 'Chat intake', ${`chat-${formId}`}, 'published',
            ${def}::jsonb, ${def}::jsonb, 1, ${settings}::jsonb, ${workspaceId})`)
  seeded.Form?.push(formId)
  return { workspaceId, contactId, conversationId, flowId, formId }
}

const startInput = (w: World, stepId = "step-1") => ({
  workspaceId: w.workspaceId,
  formId: w.formId,
  contactId: w.contactId,
  conversationId: w.conversationId,
  flowId: w.flowId,
  flowVersionId: null,
  nodeId: "node-1",
  stepId,
  maxAttempts: 2,
})

/** A reply as the inbound pipeline would store it: a fresh snowflake id. */
const answer = (w: World, text: string | null, messageId = createId()) =>
  formSessionService.answer({
    workspaceId: w.workspaceId,
    contactId: w.contactId,
    stepId: "step-1",
    reply: { messageId, text },
  })

async function track(w: World): Promise<void> {
  const rows = await db.execute<{ id: string; kind: string }>(sql`
    SELECT id::text, 'FormSession' AS kind FROM "FormSession" WHERE "contactId" = ${w.contactId}
    UNION ALL
    SELECT id::text, 'FormSubmission' FROM "FormSubmission" WHERE "formId" = ${w.formId}`)
  for (const row of rows.rows) {
    seeded[row.kind]?.push(row.id)
  }
}

async function submissions(w: World) {
  const rows = await db.execute<{
    channel: string
    score: number | null
    identityConflict: boolean
    values: Record<string, unknown>
    conversationId: string | null
  }>(sql`
    SELECT channel, score, "identityConflict", values, "conversationId"::text
      FROM "FormSubmission" WHERE "formId" = ${w.formId}`)
  return rows.rows
}

async function contactEmail(contactId: string): Promise<string | null> {
  const rows = await db.execute<{ email: string | null }>(sql`
    SELECT email FROM "Contact" WHERE id = ${contactId}`)
  return rows.rows[0]?.email ?? null
}

afterEach(async () => {
  if (!databaseUrl) {
    return
  }
  emitted.formSubmitted.length = 0
  // Runs and submissions are the service's rows: sweep them by owner, so a
  // failed assertion (which skips track()) still leaves nothing behind.
  const contacts = seeded.Contact ?? []
  if (contacts.length > 0) {
    const list = sql.join(
      contacts.map((id) => sql`${id}`),
      sql`, `,
    )
    await asReplica(sql`
      DELETE FROM "FormSubmission" WHERE "contactId" IN (${list})`)
    await asReplica(sql`
      DELETE FROM "FormSession" WHERE "contactId" IN (${list})`)
  }
  for (const table of Object.keys(seeded)) {
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

describe.skipIf(!databaseUrl)("formSessionService (real Postgres)", () => {
  test("a full run: preface once, every question in order, ONE chat submission, fields filled, one event", async () => {
    const w = await seedWorld()
    const first = await formSessionService.start(startInput(w))
    expect(first.kind).toBe("ask")
    if (first.kind !== "ask") {
      return
    }
    expect(first.field.key).toBe("name")
    expect(first.preface.map((f) => f.key)).toEqual(["hello"])

    const second = await answer(w, "Ada")
    expect(second.kind === "ask" && second.field.key).toBe("color")
    const bad = await answer(w, "green")
    expect(bad.kind === "ask" && bad.retry).toBe(true)
    const third = await answer(w, "2")
    expect(third.kind === "ask" && third.field.key).toBe("email")
    const fourth = await answer(w, "Ada@Example.com")
    expect(fourth.kind === "ask" && fourth.field.key).toBe("notes")
    const done = await answer(w, "skip")
    expect(done.kind).toBe("completed")
    await track(w)

    const rows = await submissions(w)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      channel: "chat",
      score: 5,
      identityConflict: false,
      conversationId: w.conversationId,
      values: { name: "Ada", color: "blue", email: "ada@example.com" },
    })
    expect(await contactEmail(w.contactId)).toBe("ada@example.com")
    expect(emitted.formSubmitted).toHaveLength(1)
    expect(emitted.formSubmitted[0]).toMatchObject([
      w.workspaceId,
      w.contactId,
      { channel: "chat", conversationId: w.conversationId, score: 5 },
    ])
  })

  test("a redelivered message and a reply older than the question are ignored", async () => {
    const w = await seedWorld()
    const early = createId() // sent before the question existed
    await formSessionService.start(startInput(w))
    const messageId = createId()
    const ok = await answer(w, "Ada", messageId)
    expect(ok.kind === "ask" && ok.field.key).toBe("color")
    expect(await answer(w, "Ada", messageId)).toEqual({
      kind: "ignored",
      reason: "duplicate",
    })
    expect(await answer(w, "1", early)).toEqual({
      kind: "ignored",
      reason: "stale",
    })
    expect(await answer(w, "1", "not-a-snowflake")).toEqual({
      kind: "ignored",
      reason: "stale",
    })
    await track(w)
  })

  test("two replies racing for one question: exactly one advances, the other is stale", async () => {
    const w = await seedWorld()
    await formSessionService.start(startInput(w))
    const a = createId()
    const b = createId()
    const results = await Promise.all([answer(w, "Ada", a), answer(w, "Bo", b)])
    const asks = results.filter((r) => r.kind === "ask")
    const ignored = results.filter((r) => r.kind === "ignored")
    expect(asks).toHaveLength(1)
    expect(ignored).toEqual([{ kind: "ignored", reason: "stale" }])
    await track(w)
  })

  test("two final replies racing: one completion, one submission, one event", async () => {
    const w = await seedWorld({ contactEmail: "known@example.com" })
    await formSessionService.start(startInput(w))
    await answer(w, "Ada")
    await answer(w, "1")
    // email is known -> not asked; notes is last
    const results = await Promise.all([
      answer(w, "first note"),
      answer(w, "second note"),
    ])
    expect(results.filter((r) => r.kind === "completed")).toHaveLength(1)
    await track(w)
    expect(await submissions(w)).toHaveLength(1)
    expect(emitted.formSubmitted).toHaveLength(1)
  })

  test("progressive profiling: a known email is never asked and never required", async () => {
    const w = await seedWorld({ contactEmail: "known@example.com" })
    await formSessionService.start(startInput(w))
    await answer(w, "Ada")
    const next = await answer(w, "red")
    expect(next.kind === "ask" && next.field.key).toBe("notes")
    const done = await answer(w, "all good")
    expect(done.kind).toBe("completed")
    await track(w)
    expect(await contactEmail(w.contactId)).toBe("known@example.com")
  })

  test("exhausting the attempts ends the run skipped; no submission", async () => {
    const w = await seedWorld()
    await formSessionService.start(startInput(w))
    await answer(w, "Ada")
    const retry = await answer(w, "green")
    expect(retry.kind === "ask" && retry.retry).toBe(true)
    const ended = await answer(w, "purple")
    expect(ended.kind === "ended" && ended.session.status).toBe("skipped")
    await track(w)
    expect(await submissions(w)).toHaveLength(0)
    expect(await answer(w, "1")).toEqual({
      kind: "ignored",
      reason: "noSession",
    })
  })

  test("a required question cannot be skipped", async () => {
    const w = await seedWorld()
    await formSessionService.start(startInput(w))
    const r = await answer(w, "skip")
    // "skip" is a valid NAME answer (text); the required rule is about the
    // skip word only on optional fields, so this stores "skip" as the name.
    expect(r.kind === "ask" && r.field.key).toBe("color")
    const noSkip = await answer(w, "skip")
    expect(noSkip.kind === "ask" && noSkip.retry).toBe(true)
    await track(w)
  })

  test("an email another contact holds is not written and the submission is flagged", async () => {
    const w = await seedWorld()
    const other = mintId()
    await asReplica(sql`
      INSERT INTO "Contact" (id, "workspaceId", email)
      VALUES (${other}, ${w.workspaceId}, 'taken@example.com')`)
    seeded.Contact?.push(other)
    await formSessionService.start(startInput(w))
    await answer(w, "Ada")
    await answer(w, "1")
    await answer(w, "taken@example.com")
    const done = await answer(w, "skip")
    expect(done.kind).toBe("completed")
    await track(w)
    const [row] = await submissions(w)
    expect(row?.identityConflict).toBe(true)
    expect(await contactEmail(w.contactId)).toBeNull()
  })

  test("one run per contact: the same step resumes, another step cancels and replaces", async () => {
    const w = await seedWorld()
    const a = await formSessionService.start(startInput(w))
    const again = await formSessionService.start(startInput(w))
    expect(a.kind === "ask" && again.kind === "ask").toBe(true)
    if (a.kind !== "ask" || again.kind !== "ask") {
      return
    }
    expect(again.session.id).toBe(a.session.id)
    const replaced = await formSessionService.start(startInput(w, "step-2"))
    expect(replaced.kind === "ask" && replaced.session.id).not.toBe(
      a.session.id,
    )
    await track(w)
    const rows = await db.execute<{ status: string }>(sql`
      SELECT status FROM "FormSession" WHERE id = ${a.session.id}`)
    expect(rows.rows[0]?.status).toBe("canceled")
  })

  test("two starts racing for one contact: one run, the loser is busy", async () => {
    const w = await seedWorld()
    const results = await Promise.all([
      formSessionService.start(startInput(w, "step-a")),
      formSessionService.start(startInput(w, "step-b")),
    ])
    await track(w)
    const active = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM "FormSession"
       WHERE "contactId" = ${w.contactId} AND status = 'inProgress'`)
    expect(active.rows[0]?.n).toBe(1)
    expect(results.some((r) => r.kind === "ask")).toBe(true)
  })

  test("the expiry sweep racing an answer: exactly one ends or advances the run", async () => {
    const w = await seedWorld()
    const started = await formSessionService.start(startInput(w))
    if (started.kind !== "ask") {
      throw new Error("expected ask")
    }
    await db.execute(sql`
      UPDATE "FormSession" SET "expiresAt" = now() - interval '1 minute'
       WHERE id = ${started.session.id}`)
    const [expired, answered] = await Promise.all([
      formSessionService.expireDue(),
      answer(w, "Ada"),
    ])
    const mine = expired.filter((s) => s.id === started.session.id)
    const advanced = answered.kind === "ask"
    // XOR: either the sweep ended it (and the answer found no run) or the
    // answer advanced it (and the sweep skipped the locked / refreshed row).
    expect(mine.length === 1).toBe(!advanced)
    if (mine.length === 1) {
      expect(mine[0]?.challengeId).toBe(started.session.challengeId)
      expect(answered).toEqual({ kind: "ignored", reason: "noSession" })
    }
    await track(w)
  })

  test("a form that is not published for chat is unavailable", async () => {
    const w = await seedWorld({ channels: ["web"] })
    expect(await formSessionService.start(startInput(w))).toEqual({
      kind: "unavailable",
      reason: "formNotFound",
    })
  })

  test("the CHECK keeps a web submission from losing its hashes", async () => {
    const w = await seedWorld()
    await expect(
      db.execute(sql`
        INSERT INTO "FormSubmission" (id, "definitionVersion", values, visibility,
                                      "workspaceId", "formId", channel)
        VALUES (${mintId()}, 1, '{}'::jsonb, '{"steps":[],"fields":[]}'::jsonb,
                ${w.workspaceId}, ${w.formId}, 'web')`),
    ).rejects.toThrow()
  })
})
