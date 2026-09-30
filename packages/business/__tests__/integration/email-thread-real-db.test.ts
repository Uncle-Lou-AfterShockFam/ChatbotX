// @vitest-environment node

/**
 * Outreach B-1 PR 3 (s226b): EmailThreadMail against a REAL Postgres.
 * (a) recordOutgoing is idempotent on its key under concurrent attempts,
 * (b) `latest` is the newest mail in scope, per contact AND line, incoming
 * included, (c) recordIncoming inherits the campaign of the key it cites,
 * refuses an uncitable id and is idempotent on the mail's id. Run with
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, sql } from "@chatbotx.io/database/client"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"

vi.mock("../../src/audit/dispatcher", () => ({
  dispatchAuditRecord: vi.fn(async () => undefined),
}))

const databaseUrl = requireRealDatabaseUrl()

const { emailThreadMailService } = await import("../../src/email-thread")

let nextId = 9_226_000_000_000_000n
function mintId(): string {
  nextId += 1n
  return nextId.toString()
}

const seeded: Record<string, string[]> = {
  Sequence: [],
  Inbox: [],
  Contact: [],
  Workspace: [],
}

async function asReplica(statement: ReturnType<typeof sql>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`)
    await tx.execute(statement)
  })
}

async function seed() {
  const workspaceId = mintId()
  const contactId = mintId()
  const sequenceId = mintId()
  const lineA = mintId()
  const lineB = mintId()
  await asReplica(sql`
    INSERT INTO "Workspace" (id, name, "ownerId") VALUES (${workspaceId}, ${`s226b thread ${workspaceId}`}, 1)`)
  seeded.Workspace?.push(workspaceId)
  await asReplica(sql`
    INSERT INTO "Contact" (id, "workspaceId") VALUES (${contactId}, ${workspaceId})`)
  seeded.Contact?.push(contactId)
  await asReplica(sql`
    INSERT INTO "Sequence" (id, name, "workspaceId") VALUES (${sequenceId}, ${`s226b ${sequenceId}`}, ${workspaceId})`)
  seeded.Sequence?.push(sequenceId)
  for (const id of [lineA, lineB]) {
    await asReplica(sql`
      INSERT INTO "Inbox" (id, name, channel, "sourceId", "workspaceId") VALUES (${id}, 'line', 'api', ${id}, ${workspaceId})`)
    seeded.Inbox?.push(id)
  }
  return { workspaceId, contactId, sequenceId, lineA, lineB }
}

afterEach(async () => {
  if (!databaseUrl) {
    return
  }
  const ws = seeded.Workspace ?? []
  if (ws.length > 0) {
    await asReplica(
      sql`DELETE FROM "EmailThreadMail" WHERE "workspaceId" IN (${sql.join(
        ws.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )
  }
  for (const table of ["Sequence", "Inbox", "Contact", "Workspace"]) {
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

describe.skipIf(!databaseUrl)("emailThreadMailService", () => {
  test("concurrent attempts of one send record it ONCE (the rest get null)", async () => {
    const s = await seed()
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        emailThreadMailService.recordOutgoing({
          workspaceId: s.workspaceId,
          contactId: s.contactId,
          lineInboxId: s.lineA,
          sequenceId: s.sequenceId,
          messageKey: "bt.same-key-001",
          subject: "Hello",
          parents: [],
        }),
      ),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    const found = await emailThreadMailService.findByKey({
      workspaceId: s.workspaceId,
      contactId: s.contactId,
      lineInboxId: s.lineA,
      messageKey: "bt.same-key-001",
    })
    expect(found?.subject).toBe("Hello")
    // The same key on ANOTHER line is another mail.
    expect(
      await emailThreadMailService.findByKey({
        workspaceId: s.workspaceId,
        contactId: s.contactId,
        lineInboxId: s.lineB,
        messageKey: "bt.same-key-001",
      }),
    ).toBeNull()
  })

  test("latest: newest in scope, per line; the contact's own mail counts and inherits the campaign it answers", async () => {
    const s = await seed()
    const line = {
      workspaceId: s.workspaceId,
      contactId: s.contactId,
      lineInboxId: s.lineA,
    }
    await emailThreadMailService.recordOutgoing({
      ...line,
      sequenceId: s.sequenceId,
      messageKey: "bt.seq-root-01",
      subject: "Saturday",
      parents: [],
    })
    await emailThreadMailService.recordOutgoing({
      ...line,
      messageKey: "bt.other-001",
      subject: "Other",
      parents: [],
    })
    await emailThreadMailService.recordOutgoing({
      ...line,
      lineInboxId: s.lineB,
      sequenceId: s.sequenceId,
      messageKey: "bt.line-b-001",
      subject: "On B",
      parents: [],
    })
    expect(
      (await emailThreadMailService.latest({ ...line, scope: {} }))?.messageKey,
    ).toBe("bt.other-001")
    expect(
      (
        await emailThreadMailService.latest({
          ...line,
          scope: { sequenceId: s.sequenceId },
        })
      )?.messageKey,
    ).toBe("bt.seq-root-01")
    const reply = await emailThreadMailService.recordIncoming({
      ...line,
      messageId: "<CAK-1@mail.gmail.com>",
      subject: "Re: Saturday",
      references: ["<bt.seq-root-01@aftershockfam.org>"],
    })
    expect(reply?.sequenceId).toBe(s.sequenceId)
    expect(reply?.parents).toEqual(["<bt.seq-root-01@aftershockfam.org>"])
    const inSeq = await emailThreadMailService.latest({
      ...line,
      scope: { sequenceId: s.sequenceId },
    })
    expect(inSeq?.messageId).toBe("<CAK-1@mail.gmail.com>")
    expect(
      (await emailThreadMailService.latest({ ...line, scope: {} }))?.messageId,
    ).toBe("<CAK-1@mail.gmail.com>")
    // Line B only sees its own mail.
    expect(
      (
        await emailThreadMailService.latest({
          ...line,
          lineInboxId: s.lineB,
          scope: {},
        })
      )?.messageKey,
    ).toBe("bt.line-b-001")
  })

  test("recordIncoming is idempotent on the mail's id and refuses an uncitable id", async () => {
    const s = await seed()
    const line = {
      workspaceId: s.workspaceId,
      contactId: s.contactId,
      lineInboxId: s.lineA,
    }
    const mail = {
      ...line,
      messageId: "<dup-1@mail.example>",
      subject: "Hi",
      references: [],
    }
    const [a, b] = await Promise.all([
      emailThreadMailService.recordIncoming(mail),
      emailThreadMailService.recordIncoming(mail),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1)
    for (const messageId of [
      "<a@b>\r\nBcc: x@y",
      "no-brackets@x.example",
      `<${"a".repeat(260)}@x.example>`,
    ]) {
      expect(
        await emailThreadMailService.recordIncoming({ ...mail, messageId }),
      ).toBeNull()
    }
  })

  test("forgetOutgoing deletes a failed mail unless a later mail cites it", async () => {
    const s = await seed()
    const line = {
      workspaceId: s.workspaceId,
      contactId: s.contactId,
      lineInboxId: s.lineA,
    }
    const mail = (messageKey: string, parents: string[]) =>
      emailThreadMailService.recordOutgoing({
        ...line,
        messageKey,
        subject: "s",
        parents,
      })
    await mail("bt.alone-00001", [])
    await emailThreadMailService.forgetOutgoing({
      ...line,
      messageKey: "bt.alone-00001",
    })
    expect(
      await emailThreadMailService.findByKey({
        ...line,
        messageKey: "bt.alone-00001",
      }),
    ).toBeNull()
    await mail("bt.cited-00001", [])
    await mail("bt.child-00001", ["bt.cited-00001"])
    await emailThreadMailService.forgetOutgoing({
      ...line,
      messageKey: "bt.cited-00001",
    })
    expect(
      await emailThreadMailService.findByKey({
        ...line,
        messageKey: "bt.cited-00001",
      }),
    ).not.toBeNull()
  })

  test("withLineLock serializes one (contact, line): a second planner sees the first's row", async () => {
    const s = await seed()
    const line = {
      workspaceId: s.workspaceId,
      contactId: s.contactId,
      lineInboxId: s.lineA,
    }
    // Each planner: read the newest, then record a child of it (or a root).
    const plan = (key: string) =>
      emailThreadMailService.withLineLock(line, async (tx) => {
        const parent = await emailThreadMailService.latest({
          ...line,
          scope: {},
          tx,
        })
        await new Promise((r) => setTimeout(r, 20))
        return emailThreadMailService.recordOutgoing({
          ...line,
          messageKey: key,
          subject: "s",
          parents: parent?.messageKey ? [parent.messageKey] : [],
          tx,
        })
      })
    const rows = await Promise.all(
      Array.from({ length: 6 }, (_, i) => plan(`bt.lock-${i}-00001`)),
    )
    // Exactly one root; every other mail chains under an earlier one.
    expect(rows.filter((r) => r?.parents.length === 0)).toHaveLength(1)
  })
})
