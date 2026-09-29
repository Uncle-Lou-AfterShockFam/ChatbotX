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

const emitted = vi.hoisted(() => ({
  formSubmitted: [] as unknown[],
  formAbandoned: [] as unknown[][],
}))
vi.mock("@chatbotx.io/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/events")>()),
  emitFormSubmitted: vi.fn((...args: unknown[]) => {
    emitted.formSubmitted.push(args)
    return Promise.resolve()
  }),
  emitFormAbandoned: vi.fn((...args: unknown[]) => {
    emitted.formAbandoned.push(args)
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

const { formSessionService, FORM_ASK_PENDING_MARKER } = await import(
  "../../src/form/session"
)
type Action = Awaited<ReturnType<typeof formSessionService.answer>>

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
  ContactInbox: [],
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
  contactInboxId: string
  flowId: string
  formId: string
}

const PHONE_FORM = {
  steps: [
    {
      id: "s1",
      title: "",
      fields: [
        {
          key: "phone",
          type: "phone",
          label: "Phone?",
          required: true,
          mapTo: { kind: "system", key: "phoneNumber" },
        },
      ],
    },
  ],
  rules: [],
}

async function seedWorld(
  props: {
    contactEmail?: string
    channels?: string[]
    definition?: unknown
  } = {},
): Promise<World> {
  const workspaceId = mintId()
  const contactId = mintId()
  const conversationId = mintId()
  const contactInboxId = mintId()
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
    INSERT INTO "ContactInbox" (id, "contactId", "originalContactId", "inboxId",
                                "sourceId", channel, source)
    VALUES (${contactInboxId}, ${contactId}, ${contactId}, 1,
            ${`src-${contactInboxId}`}, 'webchat', 'webchat')`)
  seeded.ContactInbox?.push(contactInboxId)
  await asReplica(sql`
    INSERT INTO "Flow" (id, name, "workspaceId") VALUES (${flowId}, 'a2-2', ${workspaceId})`)
  seeded.Flow?.push(flowId)
  const settings = JSON.stringify({ channels: props.channels ?? ["chat"] })
  const def = JSON.stringify(props.definition ?? DEFINITION)
  await asReplica(sql`
    INSERT INTO "Form" (id, title, slug, status, definition, "publishedDefinition",
                        "definitionVersion", settings, "workspaceId")
    VALUES (${formId}, 'Chat intake', ${`chat-${formId}`}, 'published',
            ${def}::jsonb, ${def}::jsonb, 1, ${settings}::jsonb, ${workspaceId})`)
  seeded.Form?.push(formId)
  return {
    workspaceId,
    contactId,
    conversationId,
    contactInboxId,
    flowId,
    formId,
  }
}

const startInput = (w: World, stepId = "step-1") => ({
  workspaceId: w.workspaceId,
  formId: w.formId,
  contactId: w.contactId,
  conversationId: w.conversationId,
  contactInboxId: w.contactInboxId,
  flowId: w.flowId,
  flowVersionId: null,
  nodeId: "node-1",
  stepId,
  maxAttempts: 2,
})

/** The worker confirms delivery of every question it asks (markAsked). */
async function delivered(action: Action): Promise<Action> {
  if (action.kind === "ask" && action.session.challengeId) {
    await formSessionService.markAsked({
      workspaceId: action.session.workspaceId,
      sessionId: action.session.id,
      challengeId: action.session.challengeId,
    })
  }
  return action
}

const start = async (w: World, stepId = "step-1") =>
  await delivered(await formSessionService.start(startInput(w, stepId)))

/** A reply as the inbound pipeline would store it: a fresh snowflake id. */
const answer = async (w: World, text: string | null, messageId = createId()) =>
  await delivered(
    await formSessionService.answer({
      workspaceId: w.workspaceId,
      contactId: w.contactId,
      conversationId: w.conversationId,
      contactInboxId: w.contactInboxId,
      stepId: "step-1",
      reply: { messageId, read: () => text },
    }),
  )

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
  emitted.formAbandoned.length = 0
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
    const first = await start(w)
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

  test("hidden fields are never asked, yet their defaults reach the rules and the ONE submission (s220c A2-4)", async () => {
    const w = await seedWorld({
      definition: {
        steps: [
          {
            id: "s1",
            title: "",
            fields: [
              {
                key: "source",
                type: "hidden",
                label: "",
                required: false,
                defaultValue: "chat-bot",
              },
              { key: "ref", type: "hidden", label: "", required: false },
              { key: "mail", type: "email", label: "Email?", required: false },
            ],
          },
        ],
        // mail is optional unless source = chat-bot: the default must be SEEN
        rules: [
          {
            id: "r1",
            when: {
              logic: "AND",
              rules: [{ fieldKey: "source", op: "eq", value: "chat-bot" }],
            },
            action: { type: "require", fieldKey: "mail" },
          },
        ],
      },
    })
    const first = await start(w)
    expect(first.kind === "ask" && first.field.key).toBe("mail")
    // required ONLY through the rule reading the default: "skip" is not a
    // skip (an optional field would advance) but a bad email, so a retry
    const refused = await answer(w, "skip")
    expect(refused.kind === "ask" && refused.retry).toBe(true)
    const done = await answer(w, "ada@example.com")
    expect(done.kind).toBe("completed")
    await track(w)
    const rows = await submissions(w)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.values).toEqual({
      source: "chat-bot",
      mail: "ada@example.com",
    })
    expect(emitted.formSubmitted[0]?.[2]).toMatchObject({
      values: { source: "chat-bot", mail: "ada@example.com" },
    })
  })

  test("a redelivered message and a reply older than the question are ignored", async () => {
    const w = await seedWorld()
    const early = createId() // sent before the question existed
    await start(w)
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
    await start(w)
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
    await start(w)
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
    await start(w)
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
    await start(w)
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
    await start(w)
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
    await start(w)
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
    const a = await start(w)
    const again = await start(w)
    expect(a.kind === "ask" && again.kind === "ask").toBe(true)
    if (a.kind !== "ask" || again.kind !== "ask") {
      return
    }
    expect(again.session.id).toBe(a.session.id)
    const replaced = await start(w, "step-2")
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
    const results = await Promise.all([start(w, "step-a"), start(w, "step-b")])
    await track(w)
    const active = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM "FormSession"
       WHERE "contactId" = ${w.contactId} AND status = 'inProgress'`)
    expect(active.rows[0]?.n).toBe(1)
    expect(results.some((r) => r.kind === "ask")).toBe(true)
  })

  test("the expiry sweep racing an answer: the answer never revives the run, which ends expired once", async () => {
    const w = await seedWorld()
    const started = await start(w)
    if (started.kind !== "ask") {
      throw new Error("expected ask")
    }
    await db.execute(sql`
      UPDATE "FormSession" SET "expiresAt" = now() - interval '1 minute'
       WHERE id = ${started.session.id}`)
    const [first, answered] = await Promise.all([
      formSessionService.expireDue(),
      answer(w, "Ada"),
    ])
    expect(answered.kind).toBe("ignored")
    // A pass that met the row locked by the answer skips it; the next ends it.
    const second = await formSessionService.expireDue()
    const mine = [...first, ...second].filter(
      (s) => s.id === started.session.id,
    )
    expect(mine).toHaveLength(1)
    expect(mine[0]?.challengeId).toBe(started.session.challengeId)
    await track(w)
  })

  test("a reply stored before the question was delivered never answers it", async () => {
    const w = await seedWorld()
    const raw = await formSessionService.start(startInput(w))
    if (raw.kind !== "ask") {
      throw new Error("expected ask")
    }
    expect(raw.session.askMarker).toBe(FORM_ASK_PENDING_MARKER)
    expect(await answer(w, "too early")).toEqual({
      kind: "ignored",
      reason: "stale",
    })
    await delivered(raw)
    const ok = await answer(w, "Ada")
    expect(ok.kind === "ask" && ok.field.key).toBe("color")
    // A second confirmation of the OLD question never reopens it.
    expect(
      await formSessionService.markAsked({
        workspaceId: w.workspaceId,
        sessionId: raw.session.id,
        challengeId: raw.session.challengeId ?? "",
      }),
    ).toBe(false)
    await track(w)
  })

  test("a retry retires the previous challenge id (a late picker submit is stale)", async () => {
    const w = await seedWorld()
    const first = await start(w)
    await answer(w, "Ada")
    const asked = await answer(w, "green")
    if (first.kind !== "ask" || asked.kind !== "ask") {
      throw new Error("expected ask")
    }
    const colorAsk = await formSessionService.findActive({
      workspaceId: w.workspaceId,
      contactId: w.contactId,
    })
    expect(colorAsk?.challengeId).not.toBe(first.session.challengeId)
    expect(
      await formSessionService.answer({
        workspaceId: w.workspaceId,
        contactId: w.contactId,
        conversationId: w.conversationId,
        contactInboxId: w.contactInboxId,
        stepId: "step-1",
        reply: { challengeId: first.session.challengeId ?? "", text: "red" },
      }),
    ).toEqual({ kind: "ignored", reason: "stale" })
    await track(w)
  })

  test("a reply after the timeout is ignored even before the sweep ran", async () => {
    const w = await seedWorld()
    await start(w)
    await db.execute(sql`
      UPDATE "FormSession" SET "expiresAt" = now() - interval '1 minute'
       WHERE "contactId" = ${w.contactId}`)
    expect(await answer(w, "Ada")).toEqual({
      kind: "ignored",
      reason: "expired",
    })
    await track(w)
  })

  test("an id past int8 is stale, never a database error", async () => {
    const w = await seedWorld()
    await start(w)
    expect(await answer(w, "Ada", "9999999999999999999")).toEqual({
      kind: "ignored",
      reason: "stale",
    })
    await track(w)
  })

  test("pool: more concurrent phone-mapped completions than pool connections all complete", async () => {
    const worlds = await Promise.all(
      Array.from({ length: 12 }, () => seedWorld({ definition: PHONE_FORM })),
    )
    for (const w of worlds) {
      expect((await start(w)).kind).toBe("ask")
    }
    const t0 = Date.now()
    const results = await Promise.all(
      worlds.map((w, i) => answer(w, `+1215555${String(1000 + i)}`)),
    )
    expect(results.map((r) => r.kind)).toEqual(worlds.map(() => "completed"))
    // The probe's deadlock waited out the 10 s connection timeout.
    expect(Date.now() - t0).toBeLessThan(5000)
    for (const w of worlds) {
      await track(w)
    }
  }, 60_000)

  test("an undelivered question ends the run at the next sweep; a delivered one is untouched", async () => {
    const w = await seedWorld()
    const raw = await formSessionService.start(startInput(w))
    if (raw.kind !== "ask") {
      throw new Error("expected ask")
    }
    const args = {
      workspaceId: w.workspaceId,
      sessionId: raw.session.id,
      challengeId: raw.session.challengeId ?? "",
    }
    expect(await formSessionService.markUndelivered(args)).toBe(true)
    const swept = await formSessionService.expireDue()
    const mine = swept.find((x) => x.id === raw.session.id)
    expect(mine?.status).toBe("expired")
    expect(mine?.endReason).toBe("undelivered")
    // A delivered question cannot be marked undelivered afterwards.
    const w2 = await seedWorld()
    const ok = await start(w2)
    if (ok.kind !== "ask") {
      throw new Error("expected ask")
    }
    expect(
      await formSessionService.markUndelivered({
        workspaceId: w2.workspaceId,
        sessionId: ok.session.id,
        challengeId: ok.session.challengeId ?? "",
      }),
    ).toBe(false)
    await track(w)
    await track(w2)
  })

  test("an expired run routes skip exactly once, and never while a newer run is active", async () => {
    const w = await seedWorld()
    const first = await start(w)
    if (first.kind !== "ask") {
      throw new Error("expected ask")
    }
    await db.execute(sql`
      UPDATE "FormSession" SET "expiresAt" = now() - interval '1 minute'
       WHERE id = ${first.session.id}`)
    await formSessionService.expireDue()
    const claim = {
      workspaceId: w.workspaceId,
      sessionId: first.session.id,
      contactId: w.contactId,
      conversationId: w.conversationId,
      stepId: "step-1",
    }
    const w2 = await seedWorld()
    const second = await start(w2)
    expect(second.kind).toBe("ask")
    // Contact w has no newer run: exactly one of two racing claims wins.
    const claims = await Promise.all([
      formSessionService.claimExpiredRoute(claim),
      formSessionService.claimExpiredRoute(claim),
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)
    // A newer run for the contact blocks the old run's skip.
    const w3 = await seedWorld()
    const old = await start(w3)
    if (old.kind !== "ask") {
      throw new Error("expected ask")
    }
    await db.execute(sql`
      UPDATE "FormSession" SET "expiresAt" = now() - interval '1 minute'
       WHERE id = ${old.session.id}`)
    await formSessionService.expireDue()
    await start(w3)
    expect(
      await formSessionService.claimExpiredRoute({
        workspaceId: w3.workspaceId,
        sessionId: old.session.id,
        contactId: w3.contactId,
        conversationId: w3.conversationId,
        stepId: "step-1",
      }),
    ).toBe(false)
    await track(w)
    await track(w2)
    await track(w3)
  })

  test("a question stuck undelivered (worker died mid-send) is re-asked on the next reply after 2 min", async () => {
    const w = await seedWorld()
    const raw = await formSessionService.start(startInput(w))
    if (raw.kind !== "ask") {
      throw new Error("expected ask")
    }
    expect(await answer(w, "Ada")).toEqual({ kind: "ignored", reason: "stale" })
    await db.execute(sql`
      UPDATE "FormSession" SET "updatedAt" = now() - interval '3 minutes'
       WHERE id = ${raw.session.id}`)
    const again = await formSessionService.answer({
      workspaceId: w.workspaceId,
      contactId: w.contactId,
      conversationId: w.conversationId,
      contactInboxId: w.contactInboxId,
      stepId: "step-1",
      reply: { messageId: createId(), read: () => "Ada" },
    })
    expect(again.kind === "ask" && again.field.key).toBe("name")
    await track(w)
  })

  test("a reply on another conversation or channel identity never answers", async () => {
    const w = await seedWorld()
    await start(w)
    const base = {
      workspaceId: w.workspaceId,
      contactId: w.contactId,
      stepId: "step-1",
      reply: { messageId: createId(), read: () => "Ada" },
    }
    expect(
      await formSessionService.answer({
        ...base,
        conversationId: mintId(),
        contactInboxId: w.contactInboxId,
      }),
    ).toEqual({ kind: "ignored", reason: "otherConversation" })
    expect(
      await formSessionService.answer({
        ...base,
        conversationId: w.conversationId,
        contactInboxId: mintId(),
      }),
    ).toEqual({ kind: "ignored", reason: "otherConversation" })
    await track(w)
  })

  test("start on another step names the run it replaced (its challenge must be cleared)", async () => {
    const w = await seedWorld()
    const a = await start(w)
    const b = await start(w, "step-2")
    if (a.kind !== "ask" || b.kind !== "ask") {
      throw new Error("expected ask")
    }
    expect(b.replaced).toEqual({
      conversationId: w.conversationId,
      stepId: "step-1",
      challengeId: a.session.challengeId,
    })
    await track(w)
  })

  test("a form that is not published for chat is unavailable", async () => {
    const w = await seedWorld({ channels: ["web"] })
    expect(await start(w)).toEqual({
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

/** The abandon events this world's contact got (other files share the DB). */
const abandonedFor = (w: World) =>
  emitted.formAbandoned.filter((args) => args[1] === w.contactId)

async function sessionRow(w: World) {
  const rows = await db.execute<{
    id: string
    status: string
    endReason: string | null
    lastFieldKey: string | null
    abandonEmittedAt: Date | null
  }>(sql`
    SELECT id::text, status, "endReason", "lastFieldKey", "abandonEmittedAt"
      FROM "FormSession" WHERE "contactId" = ${w.contactId}
     ORDER BY id DESC LIMIT 1`)
  const row = rows.rows[0]
  if (!row) {
    throw new Error("no session row")
  }
  return row
}

/** Make the contact's running question due now, as time passing would. */
async function makeDue(w: World): Promise<void> {
  await db.execute(sql`
    UPDATE "FormSession" SET "expiresAt" = now() - interval '1 second'
     WHERE "contactId" = ${w.contactId} AND status = 'inProgress'`)
}

describe.skipIf(!databaseUrl)(
  "formAbandoned (s220 A2-3, real Postgres)",
  () => {
    test("used-up attempts: ONE event naming the question it failed on", async () => {
      const w = await seedWorld()
      await start(w)
      await answer(w, "Ada")
      await answer(w, "green")
      const ended = await answer(w, "purple")
      expect(ended.kind).toBe("ended")
      await track(w)
      const row = await sessionRow(w)
      expect(row).toMatchObject({
        status: "skipped",
        endReason: "attempts",
        lastFieldKey: "color",
      })
      expect(row.abandonEmittedAt).not.toBeNull()
      expect(abandonedFor(w)).toHaveLength(1)
      expect(abandonedFor(w)[0]).toMatchObject([
        w.workspaceId,
        w.contactId,
        {
          formId: w.formId,
          formSessionId: row.id,
          channel: "chat",
          reason: "attempts",
          lastFieldKey: "color",
          conversationId: w.conversationId,
          flowId: w.flowId,
        },
      ])
      // A retry (the sweep's catch-up) finds it claimed.
      expect(
        await formSessionService.emitAbandoned({
          id: row.id,
          workspaceId: w.workspaceId,
        }),
      ).toBe(false)
      expect(abandonedFor(w)).toHaveLength(1)
    })

    test("timeout: two sweeps claiming the same expired run emit exactly once", async () => {
      const w = await seedWorld()
      await start(w)
      await answer(w, "Ada")
      await makeDue(w)
      const expired = (
        await formSessionService.expireDue({ limit: 500 })
      ).filter((r) => r.contactId === w.contactId)
      expect(expired).toHaveLength(1)
      const target = expired[0]
      if (!target) {
        return
      }
      expect(target.lastFieldKey).toBe("color")
      const claims = await Promise.all(
        Array.from({ length: 5 }, () =>
          formSessionService.emitAbandoned(target),
        ),
      )
      expect(claims.filter(Boolean)).toHaveLength(1)
      await track(w)
      expect(abandonedFor(w)).toHaveLength(1)
      expect(abandonedFor(w)[0]?.[2]).toMatchObject({
        reason: "timeout",
        lastFieldKey: "color",
        askedCount: 2, // the paragraph + name
      })
    })

    test("the catch-up emits for an ended run nobody claimed, once", async () => {
      const w = await seedWorld()
      await start(w)
      await makeDue(w)
      await formSessionService.expireDue({ limit: 500 })
      // The process died here: nothing claimed it.
      expect((await sessionRow(w)).abandonEmittedAt).toBeNull()
      await formSessionService.emitPendingAbandons({ limit: 500 })
      await formSessionService.emitPendingAbandons({ limit: 500 })
      await track(w)
      expect(abandonedFor(w)).toHaveLength(1)
      expect((await sessionRow(w)).abandonEmittedAt).not.toBeNull()
    })

    test("the catch-up gives up on runs that ended over a day ago: stamped, no event", async () => {
      const w = await seedWorld()
      await start(w)
      await makeDue(w)
      await formSessionService.expireDue({ limit: 500 })
      await db.execute(sql`
      UPDATE "FormSession" SET "endedAt" = now() - interval '25 hours'
       WHERE "contactId" = ${w.contactId}`)
      await formSessionService.emitPendingAbandons({ limit: 500 })
      await track(w)
      expect(abandonedFor(w)).toHaveLength(0)
      expect((await sessionRow(w)).abandonEmittedAt).not.toBeNull()
    })

    test("an undelivered question expires without an event (not the contact's doing)", async () => {
      const w = await seedWorld()
      const first = await formSessionService.start(startInput(w))
      if (first.kind !== "ask" || !first.session.challengeId) {
        throw new Error("expected an ask")
      }
      expect(
        await formSessionService.markUndelivered({
          workspaceId: w.workspaceId,
          sessionId: first.session.id,
          challengeId: first.session.challengeId,
        }),
      ).toBe(true)
      const [row] = (await formSessionService.expireDue({ limit: 500 })).filter(
        (r) => r.contactId === w.contactId,
      )
      expect(row?.endReason).toBe("undelivered")
      if (row) {
        expect(await formSessionService.emitAbandoned(row)).toBe(false)
      }
      await formSessionService.emitPendingAbandons({ limit: 500 })
      await track(w)
      expect(abandonedFor(w)).toHaveLength(0)
    })

    test("a run replaced by a newer one, or completed, never emits", async () => {
      const w = await seedWorld({ contactEmail: "known@example.com" })
      await start(w, "step-1")
      await start(w, "step-2") // cancels step-1's run: replaced
      const replaced = await db.execute<{ id: string; endReason: string }>(sql`
      SELECT id::text, "endReason" FROM "FormSession"
       WHERE "contactId" = ${w.contactId} AND status = 'canceled'`)
      expect(replaced.rows[0]?.endReason).toBe("replaced")
      const replacedId = replaced.rows[0]?.id
      if (replacedId) {
        expect(
          await formSessionService.emitAbandoned({
            id: replacedId,
            workspaceId: w.workspaceId,
          }),
        ).toBe(false)
      }
      await formSessionService.emitPendingAbandons({ limit: 500 })
      await track(w)
      expect(abandonedFor(w)).toHaveLength(0)
    })

    test("a late answer racing the timeout sweep never advances; the run ends expired with ONE event", async () => {
      const w = await seedWorld()
      await start(w)
      await makeDue(w)
      const [late] = await Promise.all([
        answer(w, "Ada"),
        formSessionService
          .expireDue({ limit: 500 })
          .then((rows) =>
            Promise.all(
              rows
                .filter((r) => r.contactId === w.contactId)
                .map((r) => formSessionService.emitAbandoned(r)),
            ),
          ),
      ])
      await track(w)
      // Past its timeout a reply never advances: it sees the run expired
      // (answer first) or gone (sweep first).
      expect(late.kind).toBe("ignored")
      expect(["expired", "noSession"]).toContain(
        late.kind === "ignored" ? late.reason : "",
      )
      // SKIP LOCKED: a sweep that met the answer's row lock skipped it this
      // pass; the next minute's sweep ends it. Either way: ONE event.
      for (const r of (
        await formSessionService.expireDue({ limit: 500 })
      ).filter((x) => x.contactId === w.contactId)) {
        await formSessionService.emitAbandoned(r)
      }
      await track(w)
      const row = await sessionRow(w)
      expect(row.status).toBe("expired")
      expect(abandonedFor(w)).toHaveLength(1)
    })
  },
)
