// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * s229b mailbox senders, the DB-free half: the credential blob's encryption
 * (round trip, AAD bound to the row) and every entry point's unhappy path
 * (null / wrong type / unknown keys / empty / out of range) refused BEFORE
 * any query, with a message that never echoes a password. The SQL half
 * (feed scoping, pick order, attribution) is email-sender-real-db.test.ts.
 */
const { dbTouched } = vi.hoisted(() => ({ dbTouched: vi.fn() }))
vi.mock("@chatbotx.io/database/client", async (importOriginal) => {
  const actual = await importOriginal<object>()
  const touch = () => {
    dbTouched()
    throw new Error("db must not be reached")
  }
  return {
    ...actual,
    db: { select: touch, insert: touch, update: touch, transaction: touch },
  }
})
vi.mock("@chatbotx.io/redis", () => ({ invalidateCacheByTags: vi.fn() }))
vi.mock("../src/audit/dispatcher", () => ({ dispatchAuditRecord: vi.fn() }))

const {
  decryptEmailSenderSecret,
  emailSenderAad,
  EmailSenderUnavailableError,
  emailSenderService,
  encryptEmailSenderSecret,
} = await import("../src/email-sender")

const PASSWORD = "app-pass-SECRET-1234"
const secret = {
  smtp: {
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    user: "lou@example.com",
    password: PASSWORD,
  },
  imap: {
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    user: "lou@example.com",
    password: PASSWORD,
    mailbox: "INBOX",
  },
}
const connection = {
  smtp: { ...secret.smtp },
  imap: { ...secret.imap },
}
const validCreate = {
  workspaceId: "1",
  lineInboxId: "2",
  provider: "smtp",
  address: "Lou@Example.com",
  fromName: "Lou",
  firstName: "Lou",
  lastName: "P",
  connection,
}

beforeEach(() => dbTouched.mockClear())

describe("email sender secret (s229b)", () => {
  test("round trip: the blob holds no plaintext and decrypts only for ITS row", async () => {
    const blob = await encryptEmailSenderSecret(secret, "701")
    expect(JSON.stringify(blob)).not.toContain(PASSWORD)
    expect(emailSenderAad("701")).toBe("email-sender:701")
    await expect(
      decryptEmailSenderSecret({ id: "701", secret: blob }),
    ).resolves.toEqual(secret)
    // Copied to another row: the AAD differs, decryption fails.
    await expect(
      decryptEmailSenderSecret({ id: "702", secret: blob }),
    ).rejects.toThrow()
  })

  test("a tampered or malformed blob fails; an unknown key in the secret is refused on encrypt", async () => {
    const blob = await encryptEmailSenderSecret(secret, "701")
    const tampered = {
      ...blob,
      text: `${blob.text.slice(0, -2)}${blob.text.endsWith("00") ? "11" : "00"}`,
    }
    await expect(
      decryptEmailSenderSecret({ id: "701", secret: tampered }),
    ).rejects.toThrow()
    for (const bad of [null, {}, "x", 1]) {
      await expect(
        decryptEmailSenderSecret({ id: "701", secret: bad }),
      ).rejects.toThrow()
    }
    await expect(
      encryptEmailSenderSecret(
        { ...secret, extra: 1 } as unknown as typeof secret,
        "701",
      ),
    ).rejects.toThrow()
  })
})

describe("email sender entry points refuse bad input before any query (s229b)", () => {
  const expect422 = async (p: Promise<unknown>, field?: string) => {
    const err = (await p.then(
      () => null,
      (e: unknown) => e,
    )) as { httpStatusCode?: number; field?: string; message: string } | null
    expect(err?.httpStatusCode).toBe(422)
    if (field) {
      expect(err?.field).toBe(field)
    }
    expect(err?.message ?? "").not.toContain(PASSWORD)
  }

  test("create: null, a wrong type, unknown keys, empty fields, bad ranges, google_oauth and two passwords", async () => {
    const cases: [unknown, string?][] = [
      [null],
      ["x"],
      [[]],
      [{}],
      [{ ...validCreate, extra: true }],
      [{ ...validCreate, address: "" }, "address"],
      [{ ...validCreate, address: "a@b@c.com" }, "address"],
      [{ ...validCreate, address: 5 }, "address"],
      [{ ...validCreate, fromName: "  " }, "fromName"],
      [{ ...validCreate, workspaceId: "ws-1" }, "workspaceId"],
      [{ ...validCreate, provider: "google_oauth" }, "provider"],
      [{ ...validCreate, dailyLimit: 0 }, "dailyLimit"],
      [{ ...validCreate, dailyLimit: 501 }, "dailyLimit"],
      [{ ...validCreate, dailyLimit: 2.5 }, "dailyLimit"],
      [{ ...validCreate, minGapMinutes: 1441 }, "minGapMinutes"],
      [{ ...validCreate, rampPercent: 101, rampStart: 5 }, "rampPercent"],
      [{ ...validCreate, rampStart: 5 }, "rampPercent"],
      [{ ...validCreate, replyTo: "nope" }, "replyTo"],
      [{ ...validCreate, connection: null }, "connection"],
      [
        {
          ...validCreate,
          connection: { ...connection, smtp: { ...connection.smtp, port: 0 } },
        },
        "connection.smtp.port",
      ],
      [
        {
          ...validCreate,
          connection: {
            ...connection,
            smtp: { ...connection.smtp, password: "" },
          },
        },
        "connection.smtp.password",
      ],
      [
        {
          ...validCreate,
          connection: {
            ...connection,
            imap: { ...connection.imap, host: "bad host;" },
          },
        },
        "connection.imap.host",
      ],
      [
        {
          ...validCreate,
          connection: { ...connection, smtp: { ...connection.smtp, x: 1 } },
        },
      ],
      [
        {
          ...validCreate,
          connection: {
            ...connection,
            imap: { ...connection.imap, password: `${PASSWORD}-other` },
          },
        },
        "connection.imap.password",
      ],
    ]
    for (const [input, field] of cases) {
      await expect422(emailSenderService.create(input), field)
    }
    expect(dbTouched).not.toHaveBeenCalled()
  })

  test("update / setStatus / archive / list / listLines / listForLine: null, wrong type, unknown keys, empty", async () => {
    const ref = { workspaceId: "1", id: "9" }
    const calls: [() => Promise<unknown>, string?][] = [
      [() => emailSenderService.update(null)],
      [() => emailSenderService.update({ ...ref, address: "x@y.com" })],
      [() => emailSenderService.update({ ...ref, provider: "smtp" })],
      [() => emailSenderService.update({ ...ref, dailyLimit: "5" })],
      [() => emailSenderService.update({ workspaceId: "1" }), "id"],
      [() => emailSenderService.setStatus(undefined)],
      [
        () => emailSenderService.setStatus({ ...ref, status: "disconnected" }),
        "status",
      ],
      [
        () => emailSenderService.setStatus({ ...ref, status: "archived" }),
        "status",
      ],
      [() => emailSenderService.setStatus({ ...ref, status: "" }), "status"],
      [() => emailSenderService.archive(null)],
      [() => emailSenderService.archive({ ...ref, x: 1 })],
      [() => emailSenderService.archive({ workspaceId: "1", id: "" }), "id"],
      [() => emailSenderService.list(null)],
      [() => emailSenderService.list({ workspaceId: 1 }), "workspaceId"],
      [() => emailSenderService.listLines("1")],
      [() => emailSenderService.listForLine(null)],
      [() => emailSenderService.listForLine({ workspaceId: "1" })],
      [
        () =>
          emailSenderService.listForLine({
            workspaceId: "1",
            lineInboxId: "2",
            all: true,
          }),
      ],
    ]
    for (const [call, field] of calls) {
      await expect422(call(), field)
    }
    expect(dbTouched).not.toHaveBeenCalled()
  })

  test("pickForNewThread and assertThreadSender guard their props before the query", async () => {
    const tx = {
      select: () => {
        dbTouched()
        throw new Error("no")
      },
    } as never
    for (const props of [
      null,
      {},
      { workspaceId: "1" },
      { workspaceId: "x", lineInboxId: "2" },
    ]) {
      await expect(
        emailSenderService.pickForNewThread(tx, props as never),
      ).rejects.toBeInstanceOf(TypeError)
    }
    for (const props of [null, {}, { senderId: "abc" }, { senderId: 5 }]) {
      await expect(
        emailSenderService.assertThreadSender(tx, props as never),
      ).rejects.toBeInstanceOf(EmailSenderUnavailableError)
    }
    expect(dbTouched).not.toHaveBeenCalled()
  })
})
