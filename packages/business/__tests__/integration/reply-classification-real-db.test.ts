// @vitest-environment node

/**
 * Reply classification + the Outreach pipeline (s228b outreach step 2 PR 3),
 * against a REAL Postgres: the pipeline and deal services run for real.
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, sql } from "@chatbotx.io/database/client"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"

const emitted = vi.fn()
vi.mock("@chatbotx.io/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chatbotx.io/events")>()
  const stubbed: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(actual)) {
    stubbed[key] =
      key.startsWith("emit") && typeof value === "function"
        ? (...args: unknown[]) => {
            emitted(key, ...args)
            return Promise.resolve()
          }
        : value
  }
  return stubbed
})

const { replyClassificationService } = await import(
  "../../src/reply-classification"
)

const databaseUrl = requireRealDatabaseUrl()

let nextId = 9_228_300_000_000_000n
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

/** A workspace, a contact, a sequence and the contact's enrolment in it. */
async function seed(props: { replyState?: string } = {}) {
  const workspaceId = mintId()
  const contactId = mintId()
  const sequenceId = mintId()
  const enrollmentId = mintId()
  workspaces.push(workspaceId)
  await asReplica(sql`
    INSERT INTO "Workspace" (id, name, "ownerId") VALUES (${workspaceId}, 's228b', ${mintId()})`)
  await asReplica(sql`
    INSERT INTO "Contact" (id, "workspaceId", "firstName", "lastName")
    VALUES (${contactId}, ${workspaceId}, 'Lou', 'Test')`)
  await asReplica(sql`
    INSERT INTO "Sequence" (id, name, "workspaceId", "stopOnReply")
    VALUES (${sequenceId}, ${`Cold ${sequenceId}`}, ${workspaceId}, true)`)
  await asReplica(sql`
    INSERT INTO "ContactOnSequence" (id, "contactId", "sequenceId", "workspaceId", status, "replyState")
    VALUES (${enrollmentId}, ${contactId}, ${sequenceId}, ${workspaceId}, 'ended', ${props.replyState ?? "replied"})`)
  return { workspaceId, contactId, sequenceId, enrollmentId }
}

/** The rows of `table` that belong to one workspace (by parent where needed). */
function deleteFor(table: string, workspaceId: string) {
  if (table === "PipelineStage") {
    return sql`DELETE FROM "PipelineStage" WHERE "pipelineId" IN (SELECT id FROM "Pipeline" WHERE "workspaceId" = ${workspaceId})`
  }
  if (table === "DealActivity") {
    return sql`DELETE FROM "DealActivity" WHERE "dealId" IN (SELECT id FROM "Deal" WHERE "workspaceId" = ${workspaceId})`
  }
  return sql`DELETE FROM ${sql.identifier(table)} WHERE "workspaceId" = ${workspaceId}`
}

afterEach(async () => {
  if (!databaseUrl) {
    return
  }
  for (const workspaceId of workspaces.splice(0)) {
    for (const table of [
      "ReplyClassification",
      "DealActivity",
      "Deal",
      "ContactOnSequence",
      "Sequence",
      "PipelineStage",
      "Pipeline",
      "Contact",
    ]) {
      await asReplica(deleteFor(table, workspaceId))
    }
    await asReplica(sql`DELETE FROM "Workspace" WHERE id = ${workspaceId}`)
  }
})

afterAll(async () => {
  if (!databaseUrl) {
    return
  }
  await db.$client.end()
})

async function deals(workspaceId: string) {
  const result = await db.execute<{
    id: string
    stageId: string
    status: string
    title: string
  }>(sql`
    SELECT id::text, "stageId"::text AS "stageId", status, title FROM "Deal"
     WHERE "workspaceId" = ${workspaceId} ORDER BY id`)
  return result.rows
}

describe.skipIf(!databaseUrl)("createOutreachPipeline", () => {
  test("creates the six stages in order, links the sequence and maps every key", async () => {
    const s = await seed()
    const { pipelineId, stages } =
      await replyClassificationService.createOutreachPipeline({
        workspaceId: s.workspaceId,
        sequenceId: s.sequenceId,
      })
    const rows = await db.execute<{
      id: string
      name: string
      isLost: boolean
      isWon: boolean
    }>(sql`
      SELECT id::text, name, "isLost", "isWon" FROM "PipelineStage"
       WHERE "pipelineId" = ${pipelineId} ORDER BY "order"`)
    expect(rows.rows.map((r) => r.name)).toEqual([
      "Interested",
      "Maybe later",
      "Meeting booked",
      "Meeting completed",
      "Won",
      "Not interested",
    ])
    expect(stages.interested).toBe(rows.rows[0]?.id)
    expect(stages.notInterested).toBe(rows.rows[5]?.id)
    expect(rows.rows[4]?.isWon).toBe(true)
    expect(rows.rows[5]?.isLost).toBe(true)
    const seq = await db.execute<{ p: string; st: unknown }>(sql`
      SELECT "outreachPipelineId"::text AS p, "outreachStages" AS st FROM "Sequence" WHERE id = ${s.sequenceId}`)
    expect(seq.rows[0]?.p).toBe(pipelineId)
    expect(seq.rows[0]?.st).toEqual(stages)
  })

  test("a taken name is a 400; another workspace's sequence is a 404; bad input is refused", async () => {
    const s = await seed()
    await replyClassificationService.createOutreachPipeline({
      workspaceId: s.workspaceId,
      sequenceId: s.sequenceId,
    })
    await expect(
      replyClassificationService.createOutreachPipeline({
        workspaceId: s.workspaceId,
        sequenceId: s.sequenceId,
      }),
    ).rejects.toMatchObject({ httpStatusCode: 400 })
    await expect(
      replyClassificationService.createOutreachPipeline({
        workspaceId: s.workspaceId,
        sequenceId: s.sequenceId,
        name: "Outreach 2",
      }),
    ).resolves.toBeTruthy()
    const other = await seed()
    await expect(
      replyClassificationService.createOutreachPipeline({
        workspaceId: other.workspaceId,
        sequenceId: s.sequenceId,
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    await expect(
      replyClassificationService.createOutreachPipeline({
        workspaceId: "x",
        sequenceId: s.sequenceId,
      }),
    ).rejects.toMatchObject({ httpStatusCode: 422 })
    await expect(
      replyClassificationService.createOutreachPipeline(null as never),
    ).rejects.toThrow(TypeError)
  })
})

describe.skipIf(!databaseUrl)("classifyReply", () => {
  const classify = (
    s: { workspaceId: string; contactId: string },
    cls: "interested" | "maybeLater" | "notInterested",
  ) =>
    replyClassificationService.classifyReply({
      workspaceId: s.workspaceId,
      contactId: s.contactId,
      class: cls,
      source: "manual",
      reason: "  said  yes \n on the call ",
    })

  test("interested opens ONE deal at Interested; maybeLater moves it; notInterested loses it; every step emits the trigger", async () => {
    emitted.mockClear()
    const s = await seed()
    const { stages } = await replyClassificationService.createOutreachPipeline({
      workspaceId: s.workspaceId,
      sequenceId: s.sequenceId,
    })
    const first = await classify(s, "interested")
    expect(first.classification).toMatchObject({
      class: "interested",
      source: "manual",
      reason: "said yes on the call",
      sequenceId: s.sequenceId,
    })
    let rows = await deals(s.workspaceId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      stageId: stages.interested,
      status: "open",
    })
    expect(rows[0]?.title).toContain("Lou Test")
    expect(first.dealId).toBe(rows[0]?.id)

    await classify(s, "maybeLater")
    rows = await deals(s.workspaceId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.stageId).toBe(stages.maybeLater)

    await classify(s, "notInterested")
    rows = await deals(s.workspaceId)
    expect(rows[0]).toMatchObject({
      stageId: stages.notInterested,
      status: "lost",
    })

    const triggers = emitted.mock.calls.filter(
      ([name]) => name === "emitContactReplyClassified",
    )
    expect(
      triggers.map(([, , , meta]) => (meta as { class: string }).class),
    ).toEqual(["interested", "maybeLater", "notInterested"])
  })

  test("notInterested with no open deal records only; a sequence with no pipeline records with no deal", async () => {
    const s = await seed()
    await replyClassificationService.createOutreachPipeline({
      workspaceId: s.workspaceId,
      sequenceId: s.sequenceId,
    })
    const lost = await classify(s, "notInterested")
    expect(lost.dealId).toBeNull()
    expect(await deals(s.workspaceId)).toEqual([])

    const bare = await seed()
    const r = await classify(bare, "interested")
    expect(r.classification).toMatchObject({
      class: "interested",
      sequenceId: null,
    })
    expect(r.dealId).toBeNull()
  })

  test("rule classes: recorded for an outreach contact (no deal), skipped for anyone else; the class/source pairing is enforced", async () => {
    const s = await seed()
    await replyClassificationService.createOutreachPipeline({
      workspaceId: s.workspaceId,
      sequenceId: s.sequenceId,
    })
    const ooo = await replyClassificationService.classifyReply({
      workspaceId: s.workspaceId,
      contactId: s.contactId,
      class: "ooo",
      source: "rule",
    })
    expect(ooo.classification).toMatchObject({ class: "ooo", source: "rule" })
    expect(await deals(s.workspaceId)).toEqual([])

    const outsider = await seed()
    await expect(
      replyClassificationService.classifyReply({
        workspaceId: outsider.workspaceId,
        contactId: outsider.contactId,
        class: "bounce",
        source: "rule",
      }),
    ).resolves.toEqual({ classification: null, dealId: null })

    for (const bad of [
      { class: "interested", source: "rule" },
      { class: "ooo", source: "manual" },
      { class: "yes", source: "manual" },
      { class: "interested", source: "robot" },
    ]) {
      await expect(
        replyClassificationService.classifyReply({
          workspaceId: s.workspaceId,
          contactId: s.contactId,
          ...(bad as never),
        }),
      ).rejects.toMatchObject({ httpStatusCode: 422 })
    }
  })

  test("an unknown or foreign contact is a 404; garbage ids are a 422; newest first in the list", async () => {
    const s = await seed()
    const other = await seed()
    await expect(
      replyClassificationService.classifyReply({
        workspaceId: other.workspaceId,
        contactId: s.contactId,
        class: "interested",
        source: "manual",
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    await expect(
      replyClassificationService.classifyReply({
        workspaceId: s.workspaceId,
        contactId: "1; drop",
        class: "interested",
        source: "manual",
      }),
    ).rejects.toMatchObject({ httpStatusCode: 422 })
    await classify(s, "maybeLater")
    await classify(s, "interested")
    const list = await replyClassificationService.listByContact({
      workspaceId: s.workspaceId,
      contactId: s.contactId,
    })
    expect(list.map((r) => r.class)).toEqual(["interested", "maybeLater"])
  })

  test("two concurrent interested classifications open ONE deal (the one-open-deal lock), 20 runs", async () => {
    for (let i = 0; i < 20; i++) {
      const s = await seed()
      await replyClassificationService.createOutreachPipeline({
        workspaceId: s.workspaceId,
        sequenceId: s.sequenceId,
      })
      const results = await Promise.allSettled([
        classify(s, "interested"),
        classify(s, "interested"),
      ])
      expect(results.every((r) => r.status === "fulfilled")).toBe(true)
      expect(await deals(s.workspaceId)).toHaveLength(1)
    }
  })
})
