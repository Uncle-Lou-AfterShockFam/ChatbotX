// @vitest-environment node

/**
 * Google mailbox senders (s230b) against a REAL Postgres: connect creates or
 * reconnects (never duplicates), the feed serves a fresh access token and
 * never the refresh token, one refresh per sender however many feeds ask,
 * a refused grant disconnects only at the version that failed, and a
 * transient Google failure never disconnects. Google's token endpoint is
 * MSW; the Redis lock is an in-process per-key mutex. Run with
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, eq, sql } from "@chatbotx.io/database/client"
import { emailSenderModel } from "@chatbotx.io/database/schema"
import { distributedLock } from "@chatbotx.io/redis"
import { HttpResponse, http, server } from "@chatbotx.io/vitest-config/msw"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest"

vi.mock("../../src/audit/dispatcher", () => ({
  dispatchAuditRecord: vi.fn(async () => undefined),
}))
vi.mock("../../src/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const databaseUrl = requireRealDatabaseUrl()

const { emailSenderService } = await import("../../src/email-sender")
const {
  GOOGLE_APP_CHANGED_REASON,
  GOOGLE_FEED_REFRESH_WAIT_MS,
  GOOGLE_REVOKED_REASON,
} = await import("../../src/email-sender/service")
const { decryptEmailSenderGoogleSecret, encryptEmailSenderGoogleSecret } =
  await import("../../src/email-sender/secret")
const { GOOGLE_TOKEN_URL } = await import("../../src/email-sender/google")
const { platformCredentialService } = await import(
  "../../src/platform-credential/service"
)

const CLIENT_ID = "cid-s230b.apps.googleusercontent.com"
/** Any token or secret material in a view. */
const TOKEN_MATERIAL = /ya29|1\/\/refresh|secret/
const OWNER = "1"
const REDIRECT = "https://chat.example.org/integrations/email-sender/callback"

let clientId = CLIENT_ID
// The Redis lock as an in-process per-key mutex (one test process).
const chains = new Map<string, Promise<unknown>>()

let nextId = 9_230_000_000_000_000n
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
  const line = mintId()
  await asReplica(sql`
    INSERT INTO "Workspace" (id, name, "ownerId") VALUES (${workspaceId}, ${`s230b ${workspaceId}`}, 1)`)
  seededWorkspaces.push(workspaceId)
  await asReplica(sql`
    INSERT INTO "Inbox" (id, name, channel, "sourceId", "workspaceId") VALUES (${line}, 'line', 'api', ${line}, ${workspaceId})`)
  return { workspaceId, line }
}

const idToken = (email: string) =>
  [
    "e30",
    Buffer.from(
      JSON.stringify({
        iss: "https://accounts.google.com",
        aud: CLIENT_ID,
        email,
        email_verified: true,
      }),
    ).toString("base64url"),
    "sig",
  ].join(".")

/** Google's token endpoint: a code grant for `email`, refreshes counted. */
function google(props: {
  email?: string
  refresh?: () => Response | Promise<Response>
}) {
  const calls = { code: 0, refresh: 0 }
  server.use(
    http.post(GOOGLE_TOKEN_URL, async ({ request }) => {
      const form = new URLSearchParams(await request.text())
      if (form.get("grant_type") === "authorization_code") {
        calls.code += 1
        return HttpResponse.json({
          access_token: `ya29.code-${calls.code}`,
          expires_in: 3599,
          refresh_token: `1//refresh-${calls.code}`,
          scope: "https://mail.google.com/ openid",
          id_token: idToken(props.email ?? "sender@example.org"),
        })
      }
      calls.refresh += 1
      if (props.refresh) {
        return await props.refresh()
      }
      return HttpResponse.json({
        access_token: `ya29.fresh-${calls.refresh}`,
        expires_in: 3599,
      })
    }),
  )
  return calls
}

const connect = (
  s: { workspaceId: string; line: string },
  extra: Record<string, string> = {},
) =>
  emailSenderService.connectGoogle({
    workspaceId: s.workspaceId,
    lineInboxId: s.line,
    ownerId: OWNER,
    code: "code",
    redirectUri: REDIRECT,
    ...(extra.senderId
      ? extra
      : { fromName: "Lou P", firstName: "Lou", lastName: "P", ...extra }),
  })

const feed = (s: { workspaceId: string; line: string }) =>
  emailSenderService.listForLine({
    workspaceId: s.workspaceId,
    lineInboxId: s.line,
  })

async function row(id: string) {
  const [r] = await db
    .select()
    .from(emailSenderModel)
    .where(eq(emailSenderModel.id, id))
  if (!r) {
    throw new Error("row gone")
  }
  return r
}

/** Rewrites the stored access token to expire in `ms` (no version bump). */
async function expireIn(id: string, ms: number) {
  const current = await row(id)
  const secret = await decryptEmailSenderGoogleSecret(current)
  await db
    .update(emailSenderModel)
    .set({
      secret: await encryptEmailSenderGoogleSecret(
        { ...secret, expiresAt: Date.now() + ms },
        id,
      ),
    })
    .where(eq(emailSenderModel.id, id))
}

beforeEach(() => {
  clientId = CLIENT_ID
  // Spies are restored after every test (vitest-config restoreMocks).
  vi.spyOn(platformCredentialService, "resolveForOwner").mockImplementation(
    (async () => ({
      userId: null,
      config: { clientId, clientSecret: "secret", verifyToken: "v" },
    })) as never,
  )
  vi.spyOn(distributedLock, "runExclusive").mockImplementation((async (props: {
    key: string
    fn: () => Promise<unknown>
  }) => {
    const previous = chains.get(props.key) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(() => props.fn())
    chains.set(props.key, run)
    return await run
  }) as never)
})

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
    sql`DELETE FROM "EmailSender" WHERE "workspaceId" IN (${list})`,
  )
  await asReplica(sql`DELETE FROM "Inbox" WHERE "workspaceId" IN (${list})`)
  await asReplica(sql`DELETE FROM "Workspace" WHERE id IN (${list})`)
})

afterAll(async () => {
  if (!databaseUrl) {
    return
  }
  await db.$client.end()
})

describe.skipIf(!databaseUrl)("Google mailbox senders (s230b)", () => {
  test("connect adds the consenting account; no view carries a token, the feed carries only the access token", async () => {
    const s = await seed()
    google({ email: "Sender@Example.org" })
    const view = await connect(s)
    expect(view).toMatchObject({
      provider: "google_oauth",
      address: "sender@example.org",
      status: "active",
      tokenVersion: 1,
      connection: null,
    })
    const listed = await emailSenderService.list({ workspaceId: s.workspaceId })
    for (const out of [view, listed]) {
      expect(JSON.stringify(out)).not.toMatch(TOKEN_MATERIAL)
    }
    const [fed] = await feed(s)
    expect(fed?.auth).toMatchObject({
      type: "oauth2",
      accessToken: "ya29.code-1",
    })
    expect(Date.parse((fed?.auth as { expiresAt: string }).expiresAt)).toBe(
      (await decryptEmailSenderGoogleSecret(await row(view.id))).expiresAt,
    )
    expect(fed?.smtp).toEqual({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      user: "sender@example.org",
    })
    expect(JSON.stringify(fed)).not.toContain("1//refresh")
  })

  test("a second connect of the same account reconnects the row, never a duplicate; an SMTP sender of it is a 422", async () => {
    const s = await seed()
    google({})
    const first = await connect(s)
    const again = await connect(s)
    expect(again.id).toBe(first.id)
    expect(again.tokenVersion).toBe(2)
    expect(
      await emailSenderService.list({ workspaceId: s.workspaceId }),
    ).toHaveLength(1)

    const t = await seed()
    await emailSenderService.create({
      workspaceId: t.workspaceId,
      lineInboxId: t.line,
      provider: "smtp",
      address: "sender@example.org",
      fromName: "L",
      firstName: "L",
      lastName: "P",
      connection: {
        smtp: {
          host: "smtp.gmail.com",
          port: 465,
          secure: true,
          user: "sender@example.org",
          password: "pw",
        },
        imap: {
          host: "imap.gmail.com",
          port: 993,
          secure: true,
          user: "sender@example.org",
          password: "pw",
          mailbox: "INBOX",
        },
      },
    })
    await expect(connect(t)).rejects.toMatchObject({ field: "address" })
  })

  test("a reconnect as another Google account is refused and leaves the sender as it was", async () => {
    const s = await seed()
    google({ email: "sender@example.org" })
    const view = await connect(s)
    google({ email: "someone-else@example.org" })
    await expect(connect(s, { senderId: view.id })).rejects.toMatchObject({
      code: "emailSenderGoogleMismatch",
    })
    expect((await row(view.id)).tokenVersion).toBe(1)
  })

  test("a reconnect names a sender of THIS line only (a foreign or SMTP id is a 404)", async () => {
    const s = await seed()
    const t = await seed()
    google({})
    const other = await connect(t)
    await expect(connect(s, { senderId: other.id })).rejects.toMatchObject({
      httpStatusCode: 404,
    })
  })

  test("a token close to expiry is refreshed once, stored by CAS, and served", async () => {
    const s = await seed()
    const calls = google({})
    const view = await connect(s)
    await expireIn(view.id, 60_000)
    const [fed] = await feed(s)
    expect(calls.refresh).toBe(1)
    expect(fed?.auth).toMatchObject({ accessToken: "ya29.fresh-1" })
    const stored = await row(view.id)
    expect(stored.tokenVersion).toBe(2)
    expect(stored.tokenRefreshedAt).not.toBeNull()
    const secret = await decryptEmailSenderGoogleSecret(stored)
    expect(secret.refreshToken).toBe("1//refresh-1")
    expect(secret.accessToken).toBe("ya29.fresh-1")
    // Fresh now: the next feed serves it without calling Google.
    await feed(s)
    expect(calls.refresh).toBe(1)
  })

  test("five feeds at once refresh the sender ONCE and all serve the same token", async () => {
    const s = await seed()
    const calls = google({
      refresh: async () => {
        await new Promise((r) => setTimeout(r, 50))
        return HttpResponse.json({
          access_token: "ya29.once",
          expires_in: 3599,
        })
      },
    })
    const view = await connect(s)
    await expireIn(view.id, 30_000)
    const feeds = await Promise.all([1, 2, 3, 4, 5].map(() => feed(s)))
    expect(calls.refresh).toBe(1)
    for (const [fed] of feeds) {
      expect(fed?.auth).toMatchObject({ accessToken: "ya29.once" })
    }
    expect((await row(view.id)).tokenVersion).toBe(2)
  })

  test("invalid_grant disconnects the sender: auth null, status changes 409, a reconnect restores it", async () => {
    const s = await seed()
    google({
      refresh: () =>
        HttpResponse.json({ error: "invalid_grant" }, { status: 400 }),
    })
    const view = await connect(s)
    await expireIn(view.id, 30_000)
    const [fed] = await feed(s)
    expect(fed?.auth).toBeNull()
    expect(fed?.status).toBe("disconnected")
    expect(await row(view.id)).toMatchObject({
      status: "disconnected",
      disconnectionReason: GOOGLE_REVOKED_REASON,
    })
    await expect(
      emailSenderService.setStatus({
        workspaceId: s.workspaceId,
        id: view.id,
        status: "active",
      }),
    ).rejects.toMatchObject({ httpStatusCode: 409 })
    // A disconnected sender's feed never calls Google again.
    const calls = google({})
    await feed(s)
    expect(calls.refresh).toBe(0)
    const back = await connect(s, { senderId: view.id })
    expect(back).toMatchObject({ status: "active", disconnectionReason: null })
    const [again] = await feed(s)
    expect(again?.auth).toMatchObject({ accessToken: "ya29.code-1" })
  })

  test("a refusal of an OLD grant never disconnects a sender reconnected meanwhile", async () => {
    const s = await seed()
    let view: { id: string } | null = null
    google({
      refresh: async () => {
        // A reconnect lands while Google answers the stale refresh.
        await db
          .update(emailSenderModel)
          .set({ tokenVersion: sql`${emailSenderModel.tokenVersion} + 1` })
          .where(eq(emailSenderModel.id, view?.id ?? "0"))
        return HttpResponse.json({ error: "invalid_grant" }, { status: 400 })
      },
    })
    view = await connect(s)
    await expireIn(view.id, 30_000)
    await feed(s)
    expect(await row(view.id)).toMatchObject({
      status: "active",
      disconnectionReason: null,
      tokenVersion: 2,
    })
  })

  test("a refresh that loses the CAS to a reconnect serves the reconnect's token, not its own", async () => {
    const s = await seed()
    let view: { id: string } | null = null
    google({
      refresh: async () => {
        const current = await row(view?.id ?? "0")
        const secret = await decryptEmailSenderGoogleSecret(current)
        await db
          .update(emailSenderModel)
          .set({
            secret: await encryptEmailSenderGoogleSecret(
              {
                ...secret,
                accessToken: "ya29.reconnect",
                expiresAt: Date.now() + 3_600_000,
              },
              current.id,
            ),
            tokenVersion: current.tokenVersion + 1,
          })
          .where(eq(emailSenderModel.id, current.id))
        return HttpResponse.json({
          access_token: "ya29.stale",
          expires_in: 3599,
        })
      },
    })
    view = await connect(s)
    await expireIn(view.id, 30_000)
    const [fed] = await feed(s)
    expect(fed?.auth).toMatchObject({ accessToken: "ya29.reconnect" })
    const secret = await decryptEmailSenderGoogleSecret(await row(view.id))
    expect(secret.accessToken).toBe("ya29.reconnect")
  })

  test("Google down: the unexpired stored token is served, an expired one is null, and nothing disconnects", async () => {
    const s = await seed()
    google({
      refresh: () =>
        HttpResponse.json({ error: "backend_error" }, { status: 503 }),
    })
    const view = await connect(s)
    await expireIn(view.id, 5 * 60_000)
    const [soon] = await feed(s)
    expect(soon?.auth).toMatchObject({ accessToken: "ya29.code-1" })
    await expireIn(view.id, -1000)
    const [expired] = await feed(s)
    expect(expired?.auth).toBeNull()
    expect((await row(view.id)).status).toBe("active")
  })

  test("the hub's Google app changed since the connect: disconnected with its own reason", async () => {
    const s = await seed()
    google({})
    const view = await connect(s)
    await expireIn(view.id, 30_000)
    clientId = "another-client.apps.googleusercontent.com"
    const [fed] = await feed(s)
    expect(fed?.auth).toBeNull()
    expect(await row(view.id)).toMatchObject({
      status: "disconnected",
      disconnectionReason: GOOGLE_APP_CHANGED_REASON,
    })
  })

  test("a Google sender takes no password: update with a connection is a 422, other fields save", async () => {
    const s = await seed()
    google({})
    const view = await connect(s)
    await expect(
      emailSenderService.update({
        workspaceId: s.workspaceId,
        id: view.id,
        connection: {
          smtp: {
            host: "smtp.gmail.com",
            port: 465,
            secure: true,
            user: "x",
            password: "pw",
          },
          imap: {
            host: "imap.gmail.com",
            port: 993,
            secure: true,
            user: "x",
            password: "pw",
          },
        },
      }),
    ).rejects.toMatchObject({ field: "connection" })
    const updated = await emailSenderService.update({
      workspaceId: s.workspaceId,
      id: view.id,
      fromName: "Lou Piotti",
      dailyLimit: 40,
    })
    expect(updated).toMatchObject({ fromName: "Lou Piotti", dailyLimit: 40 })
  })

  test("an archived Google sender is never refreshed nor fed", async () => {
    const s = await seed()
    const calls = google({})
    const view = await connect(s)
    await expireIn(view.id, 30_000)
    await emailSenderService.archive({
      workspaceId: s.workspaceId,
      id: view.id,
    })
    expect(await feed(s)).toEqual([])
    expect(calls.refresh).toBe(0)
  })

  test("the connect input is closed: a reconnect with names, or a new sender without them, is a 422 before Google", async () => {
    const s = await seed()
    const calls = google({})
    await expect(
      emailSenderService.connectGoogle({
        workspaceId: s.workspaceId,
        lineInboxId: s.line,
        ownerId: OWNER,
        code: "c",
        redirectUri: REDIRECT,
      }),
    ).rejects.toMatchObject({ httpStatusCode: 422 })
    await expect(
      connect(s, { senderId: "1", fromName: "x" }),
    ).rejects.toMatchObject({ httpStatusCode: 422 })
    await expect(
      emailSenderService.connectGoogle({ ...{}, junk: 1 }),
    ).rejects.toMatchObject({ httpStatusCode: 422 })
    await expect(emailSenderService.connectGoogle(null)).rejects.toMatchObject({
      httpStatusCode: 422,
    })
    expect(calls.code).toBe(0)
  })
  // Review s230b (blind probe): each of these failed before its fix.
  test("a stale invalid_grant while a reconnect lands: the feed serves the reconnect's grant as active, never 'disconnected'", async () => {
    const s = await seed()
    let view: { id: string } | null = null
    google({
      refresh: async () => {
        const current = await row(view?.id ?? "0")
        const secret = await decryptEmailSenderGoogleSecret(current)
        await db
          .update(emailSenderModel)
          .set({
            secret: await encryptEmailSenderGoogleSecret(
              {
                ...secret,
                accessToken: "ya29.reconnected",
                expiresAt: Date.now() + 3_600_000,
              },
              current.id,
            ),
            tokenVersion: current.tokenVersion + 1,
          })
          .where(eq(emailSenderModel.id, current.id))
        return HttpResponse.json({ error: "invalid_grant" }, { status: 400 })
      },
    })
    view = await connect(s)
    await expireIn(view.id, 30_000)
    const [fed] = await feed(s)
    expect(fed?.status).toBe("active")
    expect(fed?.auth).toMatchObject({ accessToken: "ya29.reconnected" })
    expect((await row(view.id)).status).toBe("active")
  })

  test("an archive landing while Google answers keeps the archived row free of the new token, and none is fed", async () => {
    const s = await seed()
    let view: { id: string } | null = null
    google({
      refresh: async () => {
        await emailSenderService.archive({
          workspaceId: s.workspaceId,
          id: view?.id ?? "0",
        })
        return HttpResponse.json({
          access_token: "ya29.after-archive",
          expires_in: 3599,
        })
      },
    })
    view = await connect(s)
    await expireIn(view.id, 30_000)
    const [fed] = await feed(s)
    expect(fed?.auth).toBeNull()
    const r = await row(view.id)
    expect(r.status).toBe("archived")
    expect((await decryptEmailSenderGoogleSecret(r)).accessToken).not.toBe(
      "ya29.after-archive",
    )
  })

  test("Google hanging never holds the feed past the wait: the stored token is fed, the late refresh is stored for the next read", async () => {
    const s = await seed()
    const ids: string[] = []
    for (let i = 0; i < 5; i += 1) {
      google({ email: `hang${i}@example.org` })
      ids.push((await connect(s)).id)
    }
    server.use(
      http.post(GOOGLE_TOKEN_URL, async () => {
        await new Promise((r) =>
          setTimeout(r, GOOGLE_FEED_REFRESH_WAIT_MS + 1500),
        )
        return HttpResponse.json({
          access_token: "ya29.late",
          expires_in: 3599,
        })
      }),
    )
    for (const id of ids) {
      await expireIn(id, 9 * 60_000)
    }
    const started = Date.now()
    const fed = await feed(s)
    // Two chunks (4 + 1), each bounded by the wait - well under the line's 10 s.
    expect(Date.now() - started).toBeLessThan(
      2 * GOOGLE_FEED_REFRESH_WAIT_MS + 1500,
    )
    for (const f of fed) {
      expect(f.auth).toMatchObject({ accessToken: "ya29.code-1" })
    }
    await new Promise((r) => setTimeout(r, 3000))
    const later = await decryptEmailSenderGoogleSecret(await row(ids[0] ?? ""))
    expect(later.accessToken).toBe("ya29.late")
  }, 30_000)

  test("a refresh failure with under 2 min left feeds null (a token the line would hold anyway), not a dying token", async () => {
    const s = await seed()
    google({
      refresh: () =>
        HttpResponse.json({ error: "backend_error" }, { status: 503 }),
    })
    const view = await connect(s)
    await expireIn(view.id, 90_000)
    const [fed] = await feed(s)
    expect(fed?.auth).toBeNull()
    expect(fed?.status).toBe("active")
  })
  test("a Google address that is not one clean address (CRLF, no @) is refused before any row is written", async () => {
    const s = await seed()
    for (const email of ["a@b.org\r\nbcc: x@evil.example", "not-an-address"]) {
      google({ email })
      await expect(connect(s)).rejects.toMatchObject({
        name: "GoogleOAuthError",
        message: "no-verified-email",
      })
    }
    expect(
      await emailSenderService.list({ workspaceId: s.workspaceId }),
    ).toEqual([])
  })
})
