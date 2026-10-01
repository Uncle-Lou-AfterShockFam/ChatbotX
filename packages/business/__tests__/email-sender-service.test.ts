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
// s230b: the service now reaches the Google app credential (and through it
// the analytics/cache modules), so the mock keeps every real export and only
// stubs cache invalidation and the refresh lock.
vi.mock("@chatbotx.io/redis", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/redis")>()),
  invalidateCacheByTags: vi.fn(),
  distributedLock: { runExclusive: vi.fn() },
}))
vi.mock("../src/audit/dispatcher", () => ({ dispatchAuditRecord: vi.fn() }))

const { EmailSenderUnavailableError, emailSenderService } = await import(
  "../src/email-sender"
)
const {
  decryptEmailSenderSecret,
  emailSenderAad,
  encryptEmailSenderSecret,
  isAllowedMailHost,
} = await import("../src/email-sender/secret")

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

describe("isAllowedMailHost (review s229b)", () => {
  test("public names and public IP literals pass; every port in the allow-list is accepted", () => {
    for (const host of [
      "smtp.gmail.com",
      "imap.gmail.com",
      "mail.example.co.uk",
      "8.8.8.8",
      "2001:4860:4860::8888",
      "SMTP.Example.COM",
    ]) {
      expect(isAllowedMailHost(host)).toBe(true)
    }
    expect(isAllowedMailHost("192.168.1.1")).toBe(false)
  })

  test("the allowed ports parse; a pasted app password keeps its inner spaces", async () => {
    const { createEmailSenderInput } = await import(
      "../src/email-sender/schema"
    )
    for (const [smtp, imap] of [
      [25, 143],
      [465, 993],
      [587, 993],
      [2525, 143],
    ]) {
      const parsed = createEmailSenderInput.parse({
        ...validCreate,
        connection: {
          smtp: {
            ...connection.smtp,
            port: smtp,
            password: "abcd efgh ijkl mnop",
          },
          imap: {
            ...connection.imap,
            port: imap,
            password: "abcd efgh ijkl mnop",
          },
        },
      })
      expect(parsed.connection.smtp.password).toBe("abcd efgh ijkl mnop")
    }
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
      // Review s229b: control characters in identity fields.
      [{ ...validCreate, fromName: "Lou\r\nBcc: x@y.com" }, "fromName"],
      [{ ...validCreate, firstName: "L\u0000ou" }, "firstName"],
      [{ ...validCreate, lastName: "P\u007f" }, "lastName"],
      [{ ...validCreate, address: "lou\u0001@example.com" }, "address"],
      [
        {
          ...validCreate,
          connection: {
            ...connection,
            smtp: { ...connection.smtp, user: "a\nb" },
          },
        },
        "connection.smtp.user",
      ],
      // Review s229b: hosts and ports refused at write time.
      ...[
        "127.0.0.1",
        "10.1.2.3",
        "192.168.0.10",
        "172.16.5.5",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "::1",
        "fe80::1",
        "fc00::1",
        "::ffff:127.0.0.1",
        "::",
        "localhost",
        "mail.localhost",
        "intranet",
        "mail..example.com",
        "-mail.example.com",
        "mail-.example.com",
        "mail.example.123",
      ].map((host): [unknown, string] => [
        {
          ...validCreate,
          connection: { ...connection, smtp: { ...connection.smtp, host } },
        },
        "connection.smtp.host",
      ]),
      ...[1, 22, 80, 993, 8025].map((port): [unknown, string] => [
        {
          ...validCreate,
          connection: { ...connection, smtp: { ...connection.smtp, port } },
        },
        "connection.smtp.port",
      ]),
      ...[110, 465, 587].map((port): [unknown, string] => [
        {
          ...validCreate,
          connection: { ...connection, imap: { ...connection.imap, port } },
        },
        "connection.imap.port",
      ]),
      // A whitespace-only password is no password on create.
      [
        {
          ...validCreate,
          connection: {
            smtp: { ...connection.smtp, password: "   " },
            imap: { ...connection.imap, password: "   " },
          },
        },
        "connection.smtp.password",
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
