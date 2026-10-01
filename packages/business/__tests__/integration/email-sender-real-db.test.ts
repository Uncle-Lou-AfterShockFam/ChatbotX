// @vitest-environment node

/**
 * ManyReach step 3 (s229b): EmailSender against a REAL Postgres. The
 * credential never appears in a view; the line feed is scoped to its own
 * inbox and drops archived senders; the new-thread pick is the least-used
 * active sender today (ties to the smallest id); inbound attribution only
 * trusts a sender of the same line. Run with
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, sql } from "@chatbotx.io/database/client"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"

vi.mock("../../src/audit/dispatcher", () => ({
  dispatchAuditRecord: vi.fn(async () => undefined),
}))
const { errorLog } = vi.hoisted(() => ({ errorLog: vi.fn() }))
vi.mock("../../src/logger", () => ({
  logger: { error: errorLog, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const databaseUrl = requireRealDatabaseUrl()

const { emailSenderService, EmailSenderUnavailableError } = await import(
  "../../src/email-sender"
)
const { emailThreadMailService } = await import("../../src/email-thread")

const PASSWORD = "app-pass-REAL-DB-9876"

let nextId = 9_229_000_000_000_000n
function mintId(): string {
  nextId += 1n
  return nextId.toString()
}

const seededWorkspaces: string[] = []

async function asReplica(statement: ReturnType<typeof sql>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`)
    await tx.execute(statement)
  })
}

async function seed() {
  const workspaceId = mintId()
  const contactId = mintId()
  const lineA = mintId()
  const lineB = mintId()
  const messenger = mintId()
  const textLine = mintId()
  await asReplica(sql`
    INSERT INTO "Workspace" (id, name, "ownerId") VALUES (${workspaceId}, ${`s229b ${workspaceId}`}, 1)`)
  seededWorkspaces.push(workspaceId)
  await asReplica(sql`
    INSERT INTO "Contact" (id, "workspaceId") VALUES (${contactId}, ${workspaceId})`)
  for (const [id, channel] of [
    [lineA, "api"],
    [lineB, "api"],
    [messenger, "messenger"],
    [textLine, "api"],
  ] as const) {
    await asReplica(sql`
      INSERT INTO "Inbox" (id, name, channel, "sourceId", "workspaceId") VALUES (${id}, 'line', ${channel}, ${id}, ${workspaceId})`)
  }
  // s231b: lineA / lineB are email lines; textLine is an API channel of
  // another kind (a GV line) that must never hold senders.
  for (const [inboxId, kind] of [
    [lineA, "email"],
    [lineB, "email"],
    [textLine, null],
  ] as const) {
    await asReplica(sql`
      INSERT INTO "IntegrationApi" (id, auth, name, "tokenHash", "tokenPrefix", "workspaceId", "inboxId", "lineKind")
      VALUES (${mintId()}, '{}'::jsonb, 'line', ${`h-${inboxId}`}, 'cbx', ${workspaceId}, ${inboxId}, ${kind})`)
  }
  return { workspaceId, contactId, lineA, lineB, messenger, textLine }
}

const connection = (address: string, password = PASSWORD) => ({
  smtp: {
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    user: address,
    password,
  },
  imap: {
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    user: address,
    password,
    mailbox: "INBOX",
  },
})

function create(
  s: { workspaceId: string },
  lineInboxId: string,
  address: string,
) {
  return emailSenderService.create({
    workspaceId: s.workspaceId,
    lineInboxId,
    provider: "smtp",
    address,
    fromName: "Lou P",
    firstName: "Lou",
    lastName: "P",
    connection: connection(address),
  })
}

async function mail(props: {
  s: { workspaceId: string; contactId: string }
  lineInboxId: string
  senderId: string | null
  direction?: "outgoing" | "incoming"
  createdAt?: string
}) {
  const id = mintId()
  await db.execute(sql`
    INSERT INTO "EmailThreadMail" (id, direction, "messageKey", "messageId", subject, "workspaceId", "contactId", "lineInboxId", "senderId", "createdAt")
    VALUES (${id}, ${props.direction ?? "outgoing"}, ${`bt.k-${id}`}, ${props.direction === "incoming" ? `<m${id}@x.example>` : null}, 's',
      ${props.s.workspaceId}, ${props.s.contactId}, ${props.lineInboxId}, ${props.senderId},
      ${props.createdAt ?? new Date().toISOString()})`)
  return id
}

afterEach(async () => {
  if (!databaseUrl) {
    return
  }
  const ws = seededWorkspaces.splice(0)
  if (ws.length === 0) {
    return
  }
  const list = sql.join(
    ws.map((id) => sql`${id}`),
    sql`, `,
  )
  await asReplica(
    sql`DELETE FROM "EmailThreadMail" WHERE "workspaceId" IN (${list})`,
  )
  await asReplica(
    sql`DELETE FROM "EmailSender" WHERE "workspaceId" IN (${list})`,
  )
  for (const table of ["IntegrationApi", "Inbox", "Contact"]) {
    await asReplica(
      sql`DELETE FROM ${sql.identifier(table)} WHERE "workspaceId" IN (${list})`,
    )
  }
  await asReplica(sql`DELETE FROM "Workspace" WHERE id IN (${list})`)
})

afterAll(async () => {
  if (!databaseUrl) {
    return
  }
  await db.$client.end()
})

const tx = () => db

describe.skipIf(!databaseUrl)("emailSenderService (s229b)", () => {
  test("create lower-cases the address; no view, list or error ever carries the secret or a password", async () => {
    const s = await seed()
    const view = await create(s, s.lineA, " Lou@Example.COM ")
    expect(view.address).toBe("lou@example.com")
    expect(view.status).toBe("active")
    expect(view.connection?.smtp).toEqual({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      // The login is trimmed but kept verbatim (servers may be case-sensitive).
      user: "Lou@Example.COM",
    })
    const listed = await emailSenderService.list({ workspaceId: s.workspaceId })
    for (const out of [
      view,
      listed,
      await emailSenderService.setStatus({
        workspaceId: s.workspaceId,
        id: view.id,
        status: "paused",
      }),
    ]) {
      const json = JSON.stringify(out)
      expect(json).not.toContain(PASSWORD)
      expect(json).not.toContain('"secret"')
      expect(json).not.toContain('"password"')
    }
    const [raw] = (
      await db.execute(
        sql`SELECT secret::text AS secret FROM "EmailSender" WHERE id = ${view.id}`,
      )
    ).rows as { secret: string }[]
    expect(raw?.secret).not.toContain(PASSWORD)
    // A duplicate on the same line is a 422 naming the address, no secret.
    const dup = await create(s, s.lineA, "lou@example.com").catch((e) => e)
    expect(dup.httpStatusCode).toBe(422)
    expect(dup.field).toBe("address")
    expect(String(dup.message)).not.toContain(PASSWORD)
  })

  test("a sender belongs to an API-channel inbox OF the workspace", async () => {
    const s = await seed()
    const other = await seed()
    const notApi = await create(s, s.messenger, "a@example.com").catch((e) => e)
    expect(notApi.httpStatusCode).toBe(422)
    const foreign = await create(s, other.lineA, "a@example.com").catch(
      (e) => e,
    )
    expect(foreign.httpStatusCode).toBe(404)
    // Another workspace cannot touch a sender either.
    const view = await create(s, s.lineA, "a@example.com")
    for (const call of [
      () =>
        emailSenderService.archive({
          workspaceId: other.workspaceId,
          id: view.id,
        }),
      () =>
        emailSenderService.setStatus({
          workspaceId: other.workspaceId,
          id: view.id,
          status: "paused",
        }),
      () =>
        emailSenderService.update({
          workspaceId: other.workspaceId,
          id: view.id,
          fromName: "x",
        }),
    ]) {
      await expect(call()).rejects.toMatchObject({ httpStatusCode: 404 })
    }
    expect(
      await emailSenderService.list({ workspaceId: other.workspaceId }),
    ).toEqual([])
  })

  test("s231b: only an API channel MARKED as an email line holds senders; another line's token never gets the feed", async () => {
    const s = await seed()
    const lines = await emailSenderService.listLines({
      workspaceId: s.workspaceId,
    })
    expect(lines.map((l) => l.id).sort()).toEqual([s.lineA, s.lineB].sort())
    const onText = await create(s, s.textLine, "a@example.com").catch((e) => e)
    expect(onText).toMatchObject({ httpStatusCode: 422, field: "lineInboxId" })
    await expect(
      emailSenderService.listForLine({
        workspaceId: s.workspaceId,
        lineInboxId: s.textLine,
      }),
    ).rejects.toMatchObject({ code: "notEmailLine", httpStatusCode: 403 })
    // A sender already on a line that is UNMARKED later is never fed again.
    await create(s, s.lineA, "a@example.com")
    expect(
      await emailSenderService.listForLine({
        workspaceId: s.workspaceId,
        lineInboxId: s.lineA,
      }),
    ).toHaveLength(1)
    await db.execute(
      sql`UPDATE "IntegrationApi" SET "lineKind" = NULL WHERE "inboxId" = ${s.lineA}`,
    )
    await expect(
      emailSenderService.listForLine({
        workspaceId: s.workspaceId,
        lineInboxId: s.lineA,
      }),
    ).rejects.toMatchObject({ code: "notEmailLine" })
    // Blind probe s231b: no new credentials on an unmarked line either.
    const [sender] = await emailSenderService.list({
      workspaceId: s.workspaceId,
      lineInboxId: s.lineA,
    })
    await expect(
      emailSenderService.update({
        workspaceId: s.workspaceId,
        id: sender.id,
        connection: connection("a@example.com", "rotated-pass-1"),
      }),
    ).rejects.toMatchObject({ field: "lineInboxId" })
  })

  test("s231b: an IntegrationApi row of ANOTHER workspace never makes an inbox an email line", async () => {
    const s = await seed()
    const other = await seed()
    await db.execute(
      sql`UPDATE "IntegrationApi" SET "workspaceId" = ${other.workspaceId}, "lineKind" = 'email' WHERE "inboxId" = ${s.textLine}`,
    )
    const lines = await emailSenderService.listLines({
      workspaceId: s.workspaceId,
    })
    expect(lines.map((l) => l.id)).not.toContain(s.textLine)
    await expect(create(s, s.textLine, "x@example.com")).rejects.toMatchObject({
      field: "lineInboxId",
    })
  })

  test("the feed: this line's non-archived senders only, WITH the password; an update with a blank password keeps it", async () => {
    const s = await seed()
    const a1 = await create(s, s.lineA, "a1@example.com")
    const a2 = await create(s, s.lineA, "a2@example.com")
    await create(s, s.lineB, "b1@example.com")
    await emailSenderService.archive({ workspaceId: s.workspaceId, id: a2.id })
    await emailSenderService.setStatus({
      workspaceId: s.workspaceId,
      id: a1.id,
      status: "draining",
    })
    const feed = await emailSenderService.listForLine({
      workspaceId: s.workspaceId,
      lineInboxId: s.lineA,
    })
    expect(feed).toHaveLength(1)
    expect(feed[0]).toMatchObject({
      id: a1.id,
      address: "a1@example.com",
      provider: "smtp",
      status: "draining",
      dailyLimit: 25,
      minGapMinutes: 10,
      rampStart: null,
      rampPercent: null,
      replyTo: null,
      smtp: {
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        user: "a1@example.com",
      },
      imap: {
        host: "imap.gmail.com",
        port: 993,
        secure: true,
        user: "a1@example.com",
        mailbox: "INBOX",
      },
      auth: { type: "password", password: PASSWORD },
    })
    expect(Object.keys(feed[0] ?? {}).sort()).toEqual(
      [
        "id",
        "address",
        "fromName",
        "replyTo",
        "provider",
        "status",
        "dailyLimit",
        "rampStart",
        "rampPercent",
        "minGapMinutes",
        "createdAt",
        "smtp",
        "imap",
        "auth",
      ].sort(),
    )
    // Another workspace's token (same line id) sees nothing: that line is not
    // an email line OF that workspace (s231b: refused, never an empty feed).
    const other = await seed()
    await expect(
      emailSenderService.listForLine({
        workspaceId: other.workspaceId,
        lineInboxId: s.lineA,
      }),
    ).rejects.toMatchObject({ code: "notEmailLine" })

    // Blank password keeps the stored one; a new one replaces it.
    const blank = connection("a1@example.com", "")
    await emailSenderService.update({
      workspaceId: s.workspaceId,
      id: a1.id,
      fromName: "Renamed",
      rampStart: 5,
      rampPercent: 20,
      connection: {
        smtp: { ...blank.smtp, host: "smtp.example.com" },
        imap: blank.imap,
      },
    })
    const kept = await emailSenderService.listForLine({
      workspaceId: s.workspaceId,
      lineInboxId: s.lineA,
    })
    expect(kept[0]).toMatchObject({
      fromName: "Renamed",
      rampStart: 5,
      rampPercent: 20,
      smtp: { host: "smtp.example.com" },
      auth: { password: PASSWORD },
    })
    await emailSenderService.update({
      workspaceId: s.workspaceId,
      id: a1.id,
      connection: connection("a1@example.com", "new-pass-000"),
    })
    const replaced = await emailSenderService.listForLine({
      workspaceId: s.workspaceId,
      lineInboxId: s.lineA,
    })
    expect(replaced[0]?.auth).toEqual({
      type: "password",
      password: "new-pass-000",
    })
    // Clearing only one half of the ramp is refused against the stored row.
    await expect(
      emailSenderService.update({
        workspaceId: s.workspaceId,
        id: a1.id,
        rampStart: null,
      }),
    ).rejects.toMatchObject({ httpStatusCode: 422, field: "rampPercent" })
    // An archived address may come back as a new sender.
    await expect(create(s, s.lineA, "a2@example.com")).resolves.toMatchObject({
      status: "active",
    })
  })

  test("a line holds at most 50 non-archived senders", async () => {
    const s = await seed()
    for (let i = 0; i < 50; i++) {
      await db.execute(sql`
        INSERT INTO "EmailSender" (id, "workspaceId", "lineInboxId", provider, address, "fromName", "firstName", "lastName", secret)
        VALUES (${mintId()}, ${s.workspaceId}, ${s.lineA}, 'smtp', ${`bulk${i}@example.com`}, 'x', 'x', 'x', '{}'::jsonb)`)
    }
    await expect(
      create(s, s.lineA, "one-more@example.com"),
    ).rejects.toMatchObject({
      httpStatusCode: 422,
      field: "lineInboxId",
    })
  })

  test("pickForNewThread: null without senders; least-used ACTIVE today, ties to the smallest id; none active fails", async () => {
    const s = await seed()
    const line = { workspaceId: s.workspaceId, lineInboxId: s.lineA }
    await expect(
      emailSenderService.pickForNewThread(tx(), line),
    ).resolves.toBeNull()
    const first = await create(s, s.lineA, "first@example.com")
    const second = await create(s, s.lineA, "second@example.com")
    const third = await create(s, s.lineA, "third@example.com")
    // All at zero: the smallest id.
    const ids = [first.id, second.id, third.id].sort((a, b) =>
      BigInt(a) < BigInt(b) ? -1 : 1,
    )
    await expect(emailSenderService.pickForNewThread(tx(), line)).resolves.toBe(
      ids[0],
    )
    // Today's outgoing counts; yesterday's and incoming ones do not; another
    // line's senders never compete.
    await mail({ s, lineInboxId: s.lineA, senderId: first.id })
    await mail({ s, lineInboxId: s.lineA, senderId: second.id })
    await mail({ s, lineInboxId: s.lineA, senderId: second.id })
    await mail({
      s,
      lineInboxId: s.lineA,
      senderId: third.id,
      createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    })
    await mail({
      s,
      lineInboxId: s.lineA,
      senderId: third.id,
      direction: "incoming",
    })
    await create(s, s.lineB, "other-line@example.com")
    await expect(emailSenderService.pickForNewThread(tx(), line)).resolves.toBe(
      third.id,
    )
    // Paused / draining are never picked; archived ones do not count as senders.
    await emailSenderService.setStatus({
      workspaceId: s.workspaceId,
      id: third.id,
      status: "paused",
    })
    await emailSenderService.setStatus({
      workspaceId: s.workspaceId,
      id: first.id,
      status: "draining",
    })
    await expect(emailSenderService.pickForNewThread(tx(), line)).resolves.toBe(
      second.id,
    )
    await emailSenderService.archive({
      workspaceId: s.workspaceId,
      id: second.id,
    })
    await expect(
      emailSenderService.pickForNewThread(tx(), line),
    ).rejects.toBeInstanceOf(EmailSenderUnavailableError)
    await emailSenderService.archive({
      workspaceId: s.workspaceId,
      id: first.id,
    })
    await emailSenderService.archive({
      workspaceId: s.workspaceId,
      id: third.id,
    })
    await expect(
      emailSenderService.pickForNewThread(tx(), line),
    ).resolves.toBeNull()
  })

  test("assertThreadSender: archived or another line's sender fails closed; paused is the daemon's to hold", async () => {
    const s = await seed()
    const a = await create(s, s.lineA, "a@example.com")
    const b = await create(s, s.lineB, "b@example.com")
    const on = (senderId: string) =>
      emailSenderService.assertThreadSender(tx(), {
        workspaceId: s.workspaceId,
        lineInboxId: s.lineA,
        senderId,
      })
    await emailSenderService.setStatus({
      workspaceId: s.workspaceId,
      id: a.id,
      status: "paused",
    })
    await expect(on(a.id)).resolves.toBeUndefined()
    await expect(on(b.id)).rejects.toBeInstanceOf(EmailSenderUnavailableError)
    await expect(on("1")).rejects.toBeInstanceOf(EmailSenderUnavailableError)
    await emailSenderService.archive({ workspaceId: s.workspaceId, id: a.id })
    await expect(on(a.id)).rejects.toMatchObject({ reason: "sender-removed" })
  })

  test("threads: recordOutgoing stores the sender; an inbound keeps ITS line's sender, ignores a foreign one and else inherits the parent's", async () => {
    const s = await seed()
    const a = await create(s, s.lineA, "a@example.com")
    const a2 = await create(s, s.lineA, "a2@example.com")
    const b = await create(s, s.lineB, "b@example.com")
    const line = {
      workspaceId: s.workspaceId,
      contactId: s.contactId,
      lineInboxId: s.lineA,
    }
    const parent = await emailThreadMailService.recordOutgoing({
      ...line,
      messageKey: "bt.parent-00001",
      subject: "Hi",
      parents: [],
      senderId: a.id,
    })
    expect(parent?.senderId).toBe(a.id)
    const cites = {
      subject: "Re: Hi",
      references: ["<bt.parent-00001@example.com>"],
    }
    const own = await emailThreadMailService.recordIncoming({
      ...line,
      ...cites,
      messageId: "<in1@x.example>",
      sender: a2.id,
    })
    expect(own?.senderId).toBe(a2.id)
    const foreign = await emailThreadMailService.recordIncoming({
      ...line,
      ...cites,
      messageId: "<in2@x.example>",
      sender: b.id,
    })
    expect(foreign?.senderId).toBe(a.id)
    const unknown = await emailThreadMailService.recordIncoming({
      ...line,
      ...cites,
      messageId: "<in3@x.example>",
      sender: "42",
    })
    expect(unknown?.senderId).toBe(a.id)
    const none = await emailThreadMailService.recordIncoming({
      ...line,
      subject: "cold",
      references: [],
      messageId: "<in4@x.example>",
    })
    expect(none?.senderId).toBeNull()
  })

  test("disconnected: no status change brings it back (409); only an update with a NEW password reconnects it", async () => {
    const s = await seed()
    const a = await create(s, s.lineA, "a@example.com")
    const b = await create(s, s.lineA, "b@example.com")
    await db.execute(sql`
      UPDATE "EmailSender" SET status = 'disconnected', "disconnectionReason" = 'AUTH failed'
      WHERE id IN (${a.id}, ${b.id})`)
    for (const status of ["active", "paused", "draining"] as const) {
      await expect(
        emailSenderService.setStatus({
          workspaceId: s.workspaceId,
          id: a.id,
          status,
        }),
      ).rejects.toMatchObject({
        httpStatusCode: 409,
        code: "emailSenderCredentialsRequired",
      })
    }
    const listed = await emailSenderService.list({ workspaceId: s.workspaceId })
    expect(listed.find((v) => v.id === a.id)).toMatchObject({
      status: "disconnected",
      disconnectionReason: "AUTH failed",
    })
    // No password, or a blank one: still disconnected.
    const blank = connection("a@example.com", "")
    for (const patch of [{ fromName: "Renamed" }, { connection: blank }]) {
      await expect(
        emailSenderService.update({
          workspaceId: s.workspaceId,
          id: a.id,
          ...patch,
        }),
      ).resolves.toMatchObject({
        status: "disconnected",
        disconnectionReason: "AUTH failed",
      })
    }
    await expect(
      emailSenderService.update({
        workspaceId: s.workspaceId,
        id: a.id,
        connection: connection("a@example.com", "fresh-pass-1"),
      }),
    ).resolves.toMatchObject({ status: "active", disconnectionReason: null })
    // A new password on a PAUSED sender does not activate it.
    await emailSenderService.setStatus({
      workspaceId: s.workspaceId,
      id: a.id,
      status: "paused",
    })
    await expect(
      emailSenderService.update({
        workspaceId: s.workspaceId,
        id: a.id,
        connection: connection("a@example.com", "fresh-pass-2"),
      }),
    ).resolves.toMatchObject({ status: "paused" })
    // An archived sender is gone (404), not "update credentials".
    await emailSenderService.archive({ workspaceId: s.workspaceId, id: b.id })
    await expect(
      emailSenderService.setStatus({
        workspaceId: s.workspaceId,
        id: b.id,
        status: "active",
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
  })

  test("an undecryptable secret stays in the feed with auth null; the log names the sender id only", async () => {
    const s = await seed()
    const good = await create(s, s.lineA, "good@example.com")
    const bad = await create(s, s.lineA, "bad@example.com")
    // Another row's blob: valid shape, wrong AAD.
    await db.execute(sql`
      UPDATE "EmailSender" SET secret = (SELECT secret FROM "EmailSender" WHERE id = ${good.id})
      WHERE id = ${bad.id}`)
    errorLog.mockClear()
    const feed = await emailSenderService.listForLine({
      workspaceId: s.workspaceId,
      lineInboxId: s.lineA,
    })
    expect(feed.map((r) => r.id)).toEqual([good.id, bad.id])
    expect(feed[0]?.auth).toEqual({ type: "password", password: PASSWORD })
    expect(feed[1]).toMatchObject({
      address: "bad@example.com",
      status: "active",
      auth: null,
      smtp: { host: "smtp.unreadable.invalid", user: "bad@example.com" },
      imap: { host: "imap.unreadable.invalid", mailbox: "INBOX" },
    })
    expect(errorLog).toHaveBeenCalledTimes(1)
    expect(errorLog.mock.calls[0]?.[0]).toEqual({ senderId: bad.id })
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(PASSWORD)
    // The UI view of it has no connection (and still no secret).
    const view = (
      await emailSenderService.list({ workspaceId: s.workspaceId })
    ).find((v) => v.id === bad.id)
    expect(view?.connection).toBeNull()
  })

  describe("review s229b: FK ON DELETE SET NULL never blocks a cascade", () => {
    const senderOf = async (mailId: string) => {
      const { rows } = await db.execute(
        sql`SELECT "senderId" FROM "EmailThreadMail" WHERE id = ${mailId}`,
      )
      return (rows[0] as { senderId: string | null } | undefined)?.senderId
    }

    test("deleting the workspace succeeds with referenced senders", async () => {
      const s = await seed()
      const a = await create(s, s.lineA, "a@example.com")
      await mail({ s, lineInboxId: s.lineA, senderId: a.id })
      await db.execute(sql`DELETE FROM "Workspace" WHERE id = ${s.workspaceId}`)
      const { rows } = await db.execute(
        sql`SELECT count(*)::int AS n FROM "EmailSender" WHERE "workspaceId" = ${s.workspaceId}`,
      )
      expect((rows[0] as { n: number }).n).toBe(0)
    })

    test("deleting the inbox succeeds; deleting a line whose sender a mail on ANOTHER line cites nulls that mail's sender", async () => {
      const s = await seed()
      const a = await create(s, s.lineA, "a@example.com")
      const b = await create(s, s.lineB, "b@example.com")
      await mail({ s, lineInboxId: s.lineA, senderId: a.id })
      // Not writable by today's code paths, but reachable in the DB.
      const crossLine = await mail({ s, lineInboxId: s.lineA, senderId: b.id })
      await db.execute(sql`DELETE FROM "Inbox" WHERE id = ${s.lineB}`)
      expect(await senderOf(crossLine)).toBeNull()
      await db.execute(sql`DELETE FROM "Inbox" WHERE id = ${s.lineA}`)
      expect(await senderOf(crossLine)).toBeUndefined()
    })
  })

  test("review s229b: a whitespace-only password keeps the stored one and does not reconnect", async () => {
    const s = await seed()
    const a = await create(s, s.lineA, "a@example.com")
    await db.execute(sql`
      UPDATE "EmailSender" SET status = 'disconnected', "disconnectionReason" = 'AUTH failed'
      WHERE id = ${a.id}`)
    const spaces = connection("a@example.com", "   ")
    await expect(
      emailSenderService.update({
        workspaceId: s.workspaceId,
        id: a.id,
        connection: spaces,
      }),
    ).resolves.toMatchObject({ status: "disconnected" })
    const [row] = await emailSenderService.listForLine({
      workspaceId: s.workspaceId,
      lineInboxId: s.lineA,
    })
    expect(row?.auth).toEqual({ type: "password", password: PASSWORD })
  })

  describe("review s229b: status writes and thread plans are serialized", () => {
    /** Resolves once some backend of this database waits on a lock. */
    const lockWaiter = async () => {
      for (let i = 0; i < 200; i++) {
        const { rows } = await db.execute(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`)
        if ((rows[0] as { n: number }).n > 0) {
          return
        }
        await new Promise((r) => setTimeout(r, 25))
      }
      throw new Error("no backend ever waited on a lock")
    }
    const hold = () => {
      let release!: () => void
      const released = new Promise<void>((r) => {
        release = r
      })
      return { release, released }
    }

    test("a follow-up plan holds its sender: archive waits for the plan's commit", async () => {
      const s = await seed()
      const a = await create(s, s.lineA, "a@example.com")
      const gate = hold()
      const ready = hold()
      const order: string[] = []
      const plan = db.transaction(async (tx) => {
        await emailSenderService.assertThreadSender(tx, {
          workspaceId: s.workspaceId,
          lineInboxId: s.lineA,
          senderId: a.id,
        })
        ready.release()
        await gate.released
        order.push("plan committed")
      })
      await ready.released
      const archive = emailSenderService
        .archive({ workspaceId: s.workspaceId, id: a.id })
        .then(() => order.push("archived"))
      await lockWaiter()
      expect(order).toEqual([])
      gate.release()
      await Promise.all([plan, archive])
      expect(order).toEqual(["plan committed", "archived"])
    })

    test("an archive in flight makes the follow-up plan fail closed once it commits", async () => {
      const s = await seed()
      const a = await create(s, s.lineA, "a@example.com")
      const gate = hold()
      const ready = hold()
      // The archive's own lock order, held open: line lock, row FOR UPDATE.
      const archiving = db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`email-sender:${s.lineA}`}, 0))`,
        )
        await tx.execute(
          sql`SELECT id FROM "EmailSender" WHERE id = ${a.id} FOR UPDATE`,
        )
        await tx.execute(
          sql`UPDATE "EmailSender" SET status = 'archived' WHERE id = ${a.id}`,
        )
        ready.release()
        await gate.released
      })
      await ready.released
      const plan = db.transaction((tx) =>
        emailSenderService.assertThreadSender(tx, {
          workspaceId: s.workspaceId,
          lineInboxId: s.lineA,
          senderId: a.id,
        }),
      )
      await lockWaiter()
      gate.release()
      await archiving
      await expect(plan).rejects.toMatchObject({ reason: "sender-removed" })
    })

    test("a new-thread pick holds the LINE lock: a status write waits for the plan's commit", async () => {
      const s = await seed()
      const a = await create(s, s.lineA, "a@example.com")
      const gate = hold()
      const ready = hold()
      const order: string[] = []
      const plan = db.transaction(async (tx) => {
        const picked = await emailSenderService.pickForNewThread(tx, {
          workspaceId: s.workspaceId,
          lineInboxId: s.lineA,
        })
        // No mail recorded here: its FK key-share lock would also hold the
        // status write, hiding whether the LINE lock does.
        expect(picked).toBe(a.id)
        ready.release()
        await gate.released
        order.push("plan committed")
      })
      await ready.released
      const pause = emailSenderService
        .setStatus({ workspaceId: s.workspaceId, id: a.id, status: "paused" })
        .then(() => order.push("paused"))
      await lockWaiter()
      expect(order).toEqual([])
      gate.release()
      await Promise.all([plan, pause])
      expect(order).toEqual(["plan committed", "paused"])
    })
  })
})
