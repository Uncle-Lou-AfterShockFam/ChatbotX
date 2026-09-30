// @vitest-environment node

/**
 * s226a (A2-5 PR 1): the form activity of a contact against a REAL Postgres,
 * where it replaced the questionnaire data.
 * - Contact filters: `formStarted`, `formInProgress` and `formSubmitted`.
 * - The Contact / Company 360 "Submissions" list.
 * - The timeline "submission" branch.
 * Every branch is pinned to the contact's own workspace, so a row carrying
 * another workspace id never counts. Timeline payload ids come back as
 * strings: a JSON number would lose digits past 2^53.
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, sql } from "@chatbotx.io/database/client"
import { operatorTypes } from "@chatbotx.io/database/partials"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"

vi.mock("@chatbotx.io/redis", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/redis")>()),
  invalidateCacheByTags: vi.fn().mockResolvedValue(undefined),
  withCache: <T>(_key: string, fn: () => Promise<T>) => fn(),
}))
vi.mock("../../src/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { contactService } = await import("../../src/contact/service")
const { formService } = await import("../../src/form/service")
const { crmTimelineService } = await import("../../src/company/timeline")

const databaseUrl = requireRealDatabaseUrl()

let nextId = 9_226_100_000_000_000n + BigInt(Date.now() % 1_000_000_000) * 1000n
const mintId = (): string => {
  nextId += 1n
  return nextId.toString()
}

async function asReplica(statement: ReturnType<typeof sql>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`)
    await tx.execute(statement)
  })
}

const DEF = JSON.stringify({ steps: [], rules: [] })
const CONTACTS = [
  "none",
  "webSubmitted",
  "chatOpen",
  "chatExpired",
  "webOpen",
  "webAbandoned",
  "webDone",
  "foreign",
] as const
type Name = (typeof CONTACTS)[number]

const ws = mintId()
const otherWs = mintId()
const formId = mintId()
const ids = Object.fromEntries(CONTACTS.map((n) => [n, mintId()])) as Record<
  Name,
  string
>

async function submission(
  contactId: string,
  channel: "web" | "chat",
  workspaceId = ws,
) {
  const hash = channel === "web" ? `h-${contactId}` : null
  await asReplica(sql`
    INSERT INTO "FormSubmission" (id, "definitionVersion", values, visibility, channel,
                                  "ipHash", "dedupHash", score, "workspaceId", "formId", "contactId")
    VALUES (${mintId()}, 1, '{}'::jsonb, '{"steps":[],"fields":[]}'::jsonb, ${channel},
            ${hash}, ${hash}, 7, ${workspaceId}, ${formId}, ${contactId})`)
}

async function session(contactId: string, status: string) {
  await asReplica(sql`
    INSERT INTO "FormSession" (id, "workspaceId", "formId", "contactId", "conversationId",
                               "contactInboxId", "flowId", "nodeId", "stepId", status,
                               "definitionVersion", definition, profile, values, asked,
                               "maxAttempts", "timeoutMinutes", "expiresAt")
    VALUES (${mintId()}, ${ws}, ${formId}, ${contactId}, ${mintId()}, ${mintId()}, ${mintId()},
            'n1', 's1', ${status}, 1, ${DEF}::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
            3, 30, now() + interval '1 hour')`)
}

async function visit(
  contactId: string,
  end: "open" | "submitted" | "abandoned",
) {
  await asReplica(sql`
    INSERT INTO "FormVisit" (id, "workspaceId", "formId", "contactId", "interactionId",
                             "startedAt", "lastActivityAt", "abandonAt",
                             "submittedAt", "abandonEmittedAt")
    VALUES (${mintId()}, ${ws}, ${formId}, ${contactId}, ${`i-${contactId}`},
            now(), now(), now() + interval '30 minutes',
            ${end === "submitted" ? sql`now()` : sql`NULL`},
            ${end === "abandoned" ? sql`now()` : sql`NULL`})`)
}

const matching = async (
  field: string,
  operator: string,
  value?: string,
): Promise<Name[]> => {
  const out: Name[] = []
  for (const name of CONTACTS) {
    const hit = await contactService.matchesContactFilter({
      workspaceId: ws,
      contactId: ids[name],
      contactFilter: {
        operator: "and",
        conditions: [{ field, operator, value } as never],
      },
    })
    if (hit) {
      out.push(name)
    }
  }
  return out
}

describe.skipIf(!databaseUrl)("form activity of a contact (real PG)", () => {
  beforeAll(async () => {
    for (const w of [ws, otherWs]) {
      await asReplica(
        sql`INSERT INTO "Workspace" (id, name, "ownerId") VALUES (${w}, 's226a', 1)`,
      )
    }
    for (const name of CONTACTS) {
      await asReplica(
        sql`INSERT INTO "Contact" (id, "workspaceId") VALUES (${ids[name]}, ${ws})`,
      )
    }
    await asReplica(sql`
      INSERT INTO "Form" (id, title, slug, status, definition, "publishedDefinition",
                          "definitionVersion", settings, "workspaceId")
      VALUES (${formId}, 'Intake', ${`intake-${formId}`}, 'published', ${DEF}::jsonb,
              ${DEF}::jsonb, 1, '{}'::jsonb, ${ws})`)
    await submission(ids.webSubmitted, "web")
    await session(ids.chatOpen, "inProgress")
    await session(ids.chatExpired, "expired")
    await visit(ids.webOpen, "open")
    await visit(ids.webAbandoned, "abandoned")
    await visit(ids.webDone, "submitted")
    await submission(ids.webDone, "chat")
    // A row naming another workspace: the pin must keep it out.
    await submission(ids.foreign, "chat", otherWs)
  })

  afterAll(async () => {
    await asReplica(
      sql`DELETE FROM "FormSubmission" WHERE "formId" = ${formId}`,
    )
    await asReplica(sql`DELETE FROM "FormSession" WHERE "formId" = ${formId}`)
    await asReplica(sql`DELETE FROM "FormVisit" WHERE "formId" = ${formId}`)
    await asReplica(sql`DELETE FROM "Form" WHERE id = ${formId}`)
    await asReplica(sql`DELETE FROM "Contact" WHERE "workspaceId" = ${ws}`)
    await asReplica(
      sql`DELETE FROM "Workspace" WHERE id IN (${ws}, ${otherWs})`,
    )
  })

  const YES = operatorTypes.enum.eq
  const EMPTY = operatorTypes.enum.isEmpty
  const NOT_EMPTY = operatorTypes.enum.isNotEmpty

  test("formSubmitted: a submission on either channel, own workspace only", async () => {
    const yes = await matching("formSubmitted", YES, "true")
    expect(yes).toEqual(["webSubmitted", "webDone"])
    expect(await matching("formSubmitted", NOT_EMPTY)).toEqual(yes)
    const no = CONTACTS.filter((n) => !yes.includes(n))
    expect(await matching("formSubmitted", YES, "false")).toEqual(no)
    expect(await matching("formSubmitted", EMPTY)).toEqual(no)
  })

  test("formInProgress: an asking chat session or an open web visit", async () => {
    const yes = await matching("formInProgress", YES, "true")
    expect(yes).toEqual(["chatOpen", "webOpen"])
    expect(await matching("formInProgress", YES, "false")).toEqual(
      CONTACTS.filter((n) => !yes.includes(n)),
    )
  })

  test("formStarted: any submission, session or visit", async () => {
    const yes = await matching("formStarted", YES, "true")
    expect(yes).toEqual([
      "webSubmitted",
      "chatOpen",
      "chatExpired",
      "webOpen",
      "webAbandoned",
      "webDone",
    ])
    expect(await matching("formStarted", YES, "false")).toEqual([
      "none",
      "foreign",
    ])
  })

  test("an operator the field does not take matches nobody (fail closed)", async () => {
    expect(
      await matching("formSubmitted", operatorTypes.enum.contains, "x"),
    ).toEqual([])
  })

  test("listByContactIds: own workspace, newest first, form title joined", async () => {
    const rows = await formService.listByContactIds({
      workspaceId: ws,
      contactIds: Object.values(ids),
    })
    expect(rows.map((r) => r.contactId).sort()).toEqual(
      [ids.webSubmitted, ids.webDone].sort(),
    )
    expect(rows.every((r) => r.formTitle === "Intake" && r.score === 7)).toBe(
      true,
    )
    expect(
      await formService.listByContactIds({ workspaceId: ws, contactIds: [] }),
    ).toEqual([])
    expect(
      await formService.listByContactIds({
        workspaceId: ws,
        contactIds: Object.values(ids),
        limit: 1,
      }),
    ).toHaveLength(1)
    expect(
      await formService.listByContactIds({
        workspaceId: otherWs,
        contactIds: [ids.foreign],
      }),
    ).toHaveLength(1)
  })

  test("timeline: a form submission row carries the form title and channel", async () => {
    const page = await crmTimelineService.forContact({
      workspaceId: ws,
      contactId: ids.webDone,
      kinds: ["submission"],
    })
    expect(page.data).toHaveLength(1)
    expect(page.data[0]?.kind).toBe("submission")
    expect(page.data[0]?.payload).toMatchObject({
      formId,
      formTitle: "Intake",
      channel: "chat",
      score: 7,
      contactId: ids.webDone,
    })
    // An int8 id past 2^53 must stay a string: jsonb_build_object over a
    // bigint column yields a JSON number, which loses digits in JS.
    expect(typeof page.data[0]?.id).toBe("string")
    const foreign = await crmTimelineService.forContact({
      workspaceId: ws,
      contactId: ids.foreign,
      kinds: ["submission"],
    })
    expect(foreign.data).toHaveLength(0)
  })
})
