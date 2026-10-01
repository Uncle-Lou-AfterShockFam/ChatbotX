import {
  and,
  asc,
  type DatabaseClient,
  db,
  eq,
  gte,
  isUniqueViolationError,
  ne,
  notInArray,
  sql,
} from "@chatbotx.io/database/client"
import {
  EMAIL_SENDER_ID,
  EMAIL_SENDER_LIMITS,
  type EmailSenderProvider,
  type EmailSenderStatus,
  GMAIL_APP_PASSWORD_PRESET,
} from "@chatbotx.io/database/partials"
import {
  emailSenderModel,
  emailThreadMailModel,
  inboxModel,
  integrationApiModel,
} from "@chatbotx.io/database/schema"
import type { EmailSenderModel } from "@chatbotx.io/database/types"
import { distributedLock } from "@chatbotx.io/redis"
import { createId } from "@chatbotx.io/utils"
import { BaseService } from "../base.service"
import {
  credentialMissingException,
  emailSenderCredentialsRequiredException,
  emailSenderGoogleMismatchException,
  notEmailLineException,
  notFoundException,
  validationException,
} from "../errors"
import { logger } from "../logger"
import { platformCredentialService } from "../platform-credential/service"
import {
  exchangeGoogleSenderCode,
  type GoogleOAuthClient,
  GoogleOAuthError,
  GoogleReconnectRequiredError,
  refreshGoogleAccessToken,
} from "./google"
import {
  connectGoogleEmailSenderInput,
  createEmailSenderInput,
  emailSenderAddress,
  emailSenderLineInput,
  emailSenderRefInput,
  listEmailSendersInput,
  parseInput,
  setEmailSenderStatusInput,
  updateEmailSenderInput,
} from "./schema"
import {
  connectionOf,
  decryptEmailSenderGoogleSecret,
  decryptEmailSenderSecret,
  type EmailSenderConnection,
  type EmailSenderGoogleSecret,
  type EmailSenderSmtpSecret,
  encryptEmailSenderGoogleSecret,
  encryptEmailSenderSecret,
} from "./secret"

const SENDER_NOT_FOUND = "Email sender not found"

/**
 * What callers outside this service see of a sender: every column but the
 * encrypted `secret`, plus its connection WITHOUT passwords (null when the
 * blob cannot be read, e.g. after a key change).
 */
export type EmailSenderView = Omit<EmailSenderModel, "secret"> & {
  connection: EmailSenderConnection | null
}

/** One row of the line's credential feed (wire contract sec. 2). */
export type EmailSenderFeedRow = {
  id: string
  address: string
  fromName: string
  replyTo: string | null
  provider: EmailSenderProvider
  status: Exclude<EmailSenderStatus, "archived">
  dailyLimit: number
  rampStart: number | null
  rampPercent: number | null
  minGapMinutes: number
  createdAt: string
  smtp: EmailSenderConnection["smtp"]
  imap: EmailSenderConnection["imap"]
  auth: EmailSenderFeedAuth | null
}

export type EmailSenderFeedAuth =
  | { type: "password"; password: string }
  /** `expiresAt` is ISO 8601; the line refreshes the feed before it. */
  | { type: "oauth2"; accessToken: string; expiresAt: string }

/**
 * A Google access token is refreshed when it has less than this left. The
 * line reads the feed every 5 min and forces a read 60 s before expiry, so
 * every token it holds has minutes to spare (s230b).
 */
export const GOOGLE_REFRESH_MARGIN_MS = 10 * 60 * 1000
/** Outlives the token call's 15 s timeout: one refresh per sender at a time. */
const GOOGLE_REFRESH_LOCK_SECONDS = 45
/**
 * How long one feed read waits for a sender's refresh (probe s230b): the
 * line's feed request gives up at 10 s, so a hanging Google or Redis must
 * never hold the whole feed. Past it the stored token is fed and the refresh
 * finishes in the background (stored for the next read).
 */
export const GOOGLE_FEED_REFRESH_WAIT_MS = 4000
/**
 * The least life a FED token has (probe s230b): the line forces a re-read
 * 60 s before expiry and at most once a minute, so a shorter-lived token
 * would only hold its mail.
 */
export const GOOGLE_FEED_MIN_TOKEN_MS = 2 * 60 * 1000
/** A Google sender's feed auth; `disconnected` when this read disconnected it. */
type GoogleFeedAuth = {
  auth: EmailSenderFeedAuth | null
  disconnected: boolean
}

/** Google senders refreshed at once while one feed is built. */
const FEED_REFRESH_CONCURRENCY = 4
/** What a sender says when Google refused its saved grant. */
export const GOOGLE_REVOKED_REASON =
  "Google refused the saved access (revoked or expired): reconnect with Google"
export const GOOGLE_APP_CHANGED_REASON =
  "The hub's Google app changed since this mailbox connected: reconnect with Google"

export type EmailSenderUnavailableReason = "no-active-sender" | "sender-removed"

/**
 * A mail's sender cannot be used (wire contract sec. 4): the thread's sender
 * was archived, or the line has senders but none active. Never falls back to
 * another mailbox: the caller fails the send closed.
 */
export class EmailSenderUnavailableError extends Error {
  readonly reason: EmailSenderUnavailableReason
  constructor(reason: EmailSenderUnavailableReason) {
    super(
      reason === "sender-removed"
        ? "the thread's sender was removed"
        : "no active sender on this email line",
    )
    this.name = "EmailSenderUnavailableError"
    this.reason = reason
  }
}

/**
 * The feed carries ONE password per sender (wire contract sec. 2), so the
 * SMTP and IMAP logins must share it (a Gmail app password always does).
 */
function assertOnePassword(secret: EmailSenderSmtpSecret) {
  if (secret.smtp.password !== secret.imap.password) {
    throw validationException(
      "connection.imap.password",
      "The SMTP and IMAP passwords must be the same",
    )
  }
}

/** The feed's logins for a sender whose secret cannot be decrypted. */
const UNREADABLE = {
  smtp: { host: "smtp.unreadable.invalid", port: 465, secure: true },
  imap: {
    host: "imap.unreadable.invalid",
    port: 993,
    secure: true,
    mailbox: "INBOX",
  },
} as const

const utcMidnight = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))

export class EmailSenderService extends BaseService {
  /** The workspace's API-channel inboxes (email lines), oldest first. */
  async listLines(input: unknown): Promise<{ id: string; name: string }[]> {
    const { workspaceId } = parseInput(listEmailSendersInput, input)
    // s231b: only API channels marked as email lines (IntegrationApi.lineKind).
    return await db
      .select({ id: inboxModel.id, name: inboxModel.name })
      .from(inboxModel)
      .innerJoin(
        integrationApiModel,
        eq(integrationApiModel.inboxId, inboxModel.id),
      )
      .where(
        and(
          eq(inboxModel.workspaceId, workspaceId),
          eq(inboxModel.channel, "api"),
          eq(integrationApiModel.lineKind, "email"),
        ),
      )
      .orderBy(asc(inboxModel.id))
  }

  /** The workspace's non-archived senders, optionally of one line. */
  async list(input: unknown): Promise<EmailSenderView[]> {
    const { workspaceId, lineInboxId } = parseInput(
      listEmailSendersInput,
      input,
    )
    const rows = await db
      .select()
      .from(emailSenderModel)
      .where(
        and(
          eq(emailSenderModel.workspaceId, workspaceId),
          lineInboxId
            ? eq(emailSenderModel.lineInboxId, lineInboxId)
            : undefined,
          ne(emailSenderModel.status, "archived"),
        ),
      )
      .orderBy(asc(emailSenderModel.lineInboxId), asc(emailSenderModel.id))
    return await Promise.all(rows.map((row) => this.toView(row)))
  }

  async create(
    input: unknown,
    userId?: string | null,
  ): Promise<EmailSenderView> {
    const data = parseInput(createEmailSenderInput, input)
    const { connection, ...fields } = data
    assertOnePassword(connection)
    await this.assertLine(data.workspaceId, data.lineInboxId)
    const id = createId()
    const secret = await encryptEmailSenderSecret(connection, id)
    const row = await db
      .transaction(async (tx) => {
        await this.lockLine(tx, data.lineInboxId)
        const [{ count = 0 } = {}] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(emailSenderModel)
          .where(
            and(
              eq(emailSenderModel.lineInboxId, data.lineInboxId),
              ne(emailSenderModel.status, "archived"),
            ),
          )
        if (count >= EMAIL_SENDER_LIMITS.perLine) {
          throw validationException(
            "lineInboxId",
            `An email line holds at most ${EMAIL_SENDER_LIMITS.perLine} senders`,
          )
        }
        const [inserted] = await tx
          .insert(emailSenderModel)
          .values({ ...fields, id, secret, status: "active" })
          .returning()
        return inserted
      })
      .catch((err: unknown) => {
        if (isUniqueViolationError(err)) {
          throw validationException(
            "address",
            "This address is already a sender on this email line",
          )
        }
        throw err
      })
    if (!row) {
      throw new Error("email sender insert returned no row")
    }
    await this.audit(
      "create",
      `added an email sender (#${row.id}) to line #${row.lineInboxId}${userId ? ` by #${userId}` : ""}`,
    )
    return await this.toView(row)
  }

  /**
   * A blank (or whitespace-only, or absent) password keeps the stored one. A
   * NEW password reconnects a disconnected sender (status active, reason
   * cleared); it leaves any other status as it is.
   */
  async update(input: unknown): Promise<EmailSenderView> {
    const { workspaceId, id, connection, ...fields } = parseInput(
      updateEmailSenderInput,
      input,
    )
    const row = await this.withLockedSender(
      workspaceId,
      id,
      async (tx, current) => {
        const rampStart =
          fields.rampStart === undefined ? current.rampStart : fields.rampStart
        const rampPercent =
          fields.rampPercent === undefined
            ? current.rampPercent
            : fields.rampPercent
        if ((rampStart === null) !== (rampPercent === null)) {
          throw validationException(
            "rampPercent",
            "Set both the ramp start and the ramp percent, or neither",
          )
        }
        if (connection && current.provider !== "smtp") {
          // A Google mailbox's logins are fixed; its access comes from a
          // reconnect with Google, never a password (s230b).
          throw validationException(
            "connection",
            "A Google mailbox has no password: reconnect it with Google",
          )
        }
        const reconnect = Boolean(
          connection?.smtp.password || connection?.imap.password,
        )
        const secret = connection
          ? await this.nextSecret(current, connection)
          : undefined
        const [updated] = await tx
          .update(emailSenderModel)
          .set({
            ...fields,
            ...(secret ? { secret } : {}),
            ...(reconnect && current.status === "disconnected"
              ? { status: "active" as const, disconnectionReason: null }
              : {}),
          })
          .where(eq(emailSenderModel.id, id))
          .returning()
        return updated
      },
    )
    await this.audit("update", `updated an email sender (#${id})`)
    return await this.toView(row)
  }

  /**
   * active | paused | draining. `disconnected` is the system's and only an
   * update with a new password leaves it (409 emailSenderCredentialsRequired
   * here). An archived sender is final (404).
   */
  async setStatus(input: unknown): Promise<EmailSenderView> {
    const { workspaceId, id, status } = parseInput(
      setEmailSenderStatusInput,
      input,
    )
    const row = await this.withLockedSender(
      workspaceId,
      id,
      async (tx, current) => {
        if (current.status === "disconnected") {
          throw emailSenderCredentialsRequiredException()
        }
        const [updated] = await tx
          .update(emailSenderModel)
          .set({ status })
          .where(eq(emailSenderModel.id, id))
          .returning()
        return updated
      },
    )
    await this.audit("update", `set email sender #${id} ${status}`)
    return await this.toView(row)
  }

  /**
   * Archives a sender (terminal; never a delete: thread mails reference it).
   * A thread that used it fails closed from now on. Its address may be added
   * to the line again as a new sender.
   */
  async archive(input: unknown): Promise<void> {
    const { workspaceId, id } = parseInput(emailSenderRefInput, input)
    await this.withLockedSender(workspaceId, id, async (tx) => {
      const [updated] = await tx
        .update(emailSenderModel)
        .set({ status: "archived" })
        .where(eq(emailSenderModel.id, id))
        .returning()
      return updated
    })
    await this.audit("delete", `archived an email sender (#${id})`)
  }

  /**
   * The line's credential feed (wire contract sec. 2): its non-archived
   * senders, at most 50, oldest first, WITH the password. Only the line's
   * own token route may call this. A row whose secret cannot be decrypted
   * stays, with `auth: null` (the line holds its mail) and an error log
   * naming the sender id only.
   */
  async listForLine(input: unknown): Promise<EmailSenderFeedRow[]> {
    const { workspaceId, lineInboxId } = parseInput(emailSenderLineInput, input)
    // s231b: a token of any other line never sees a sender's credentials.
    if (!(await this.isEmailLine(workspaceId, lineInboxId))) {
      throw notEmailLineException()
    }
    const rows = await db
      .select()
      .from(emailSenderModel)
      .where(
        and(
          eq(emailSenderModel.workspaceId, workspaceId),
          eq(emailSenderModel.lineInboxId, lineInboxId),
          ne(emailSenderModel.status, "archived"),
        ),
      )
      .orderBy(asc(emailSenderModel.id))
      .limit(EMAIL_SENDER_LIMITS.perLine)
    const googleAuth = new Map<string, GoogleFeedAuth>()
    const google = rows.filter((row) => row.provider === "google_oauth")
    for (let i = 0; i < google.length; i += FEED_REFRESH_CONCURRENCY) {
      const chunk = google.slice(i, i + FEED_REFRESH_CONCURRENCY)
      const auths = await Promise.all(
        chunk.map((row) => this.googleFeedAuth(row)),
      )
      for (const [j, row] of chunk.entries()) {
        googleAuth.set(row.id, auths[j] ?? { auth: null, disconnected: false })
      }
    }
    const feed: EmailSenderFeedRow[] = []
    for (const row of rows) {
      const base = {
        id: row.id,
        address: row.address,
        fromName: row.fromName,
        replyTo: row.replyTo,
        provider: row.provider,
        // The query excludes archived rows.
        status: row.status as EmailSenderFeedRow["status"],
        dailyLimit: row.dailyLimit,
        rampStart: row.rampStart,
        rampPercent: row.rampPercent,
        minGapMinutes: row.minGapMinutes,
        createdAt: row.createdAt.toISOString(),
      }
      if (row.provider === "google_oauth") {
        // Gmail over XOAUTH2 (s230b): a fresh access token, or null (the
        // line HOLDS this sender's mail: disconnected, unreadable, or Google
        // unreachable with no unexpired token left).
        const { smtp, imap } = GMAIL_APP_PASSWORD_PRESET
        const google = googleAuth.get(row.id)
        feed.push({
          ...base,
          // Disconnected by this very read: the line learns it now.
          ...(google?.disconnected ? { status: "disconnected" as const } : {}),
          smtp: { ...smtp, user: row.address },
          imap: { ...imap, user: row.address },
          auth: google?.auth ?? null,
        })
        continue
      }
      let secret: EmailSenderSmtpSecret
      try {
        secret = await decryptEmailSenderSecret(row)
      } catch {
        // Kept with auth null so the line HOLDS this sender's sticky mail
        // instead of failing it as an unknown sender. Its logins cannot be
        // read either: `.invalid` hosts (RFC 2606) the line never dials.
        logger.error(
          { senderId: row.id },
          "email sender secret cannot be decrypted; fed with auth null",
        )
        feed.push({
          ...base,
          smtp: { ...UNREADABLE.smtp, user: row.address },
          imap: { ...UNREADABLE.imap, user: row.address },
          auth: null,
        })
        continue
      }
      const { smtp, imap } = connectionOf(secret)
      feed.push({
        ...base,
        smtp,
        imap,
        auth: { type: "password", password: secret.smtp.password },
      })
    }
    return feed
  }

  /**
   * Connects a Gmail / Workspace mailbox with Google (s230b), called by the
   * OAuth callback after it verified the signed state. Exchanges the code
   * with the owner's Google app, then either RECONNECTS the state's sender
   * (the consenting account must be its address) or adds a new sender for
   * the consenting account. A non-archived Google sender of that address on
   * the line is reconnected, never duplicated; an SMTP sender of it is a 422.
   */
  async connectGoogle(
    input: unknown,
    userId?: string | null,
  ): Promise<EmailSenderView> {
    const data = parseInput(connectGoogleEmailSenderInput, input)
    await this.assertLine(data.workspaceId, data.lineInboxId)
    const client = await this.googleClient(data.ownerId)
    if (!client) {
      throw credentialMissingException(
        "The Google app is not configured (Admin > Platform credentials)",
      )
    }
    const grant = await exchangeGoogleSenderCode({
      client,
      code: data.code,
      redirectUri: data.redirectUri,
    })
    // The address becomes the SMTP/IMAP user and the From: the same closed
    // parser as an SMTP sender's (review s230b), never Google's raw claim.
    if (!emailSenderAddress.safeParse(grant.email).success) {
      throw new GoogleOAuthError("no-verified-email", {
        status: 200,
        retryable: false,
      })
    }
    const secretOf = (): EmailSenderGoogleSecret => ({
      refreshToken: grant.refreshToken,
      accessToken: grant.accessToken,
      expiresAt: grant.expiresAt,
      scope: grant.scope,
      clientId: client.clientId,
      ownerId: data.ownerId,
    })
    const reconnectRow = async (
      tx: DatabaseClient,
      current: EmailSenderModel,
    ) => {
      if (
        current.provider !== "google_oauth" ||
        current.lineInboxId !== data.lineInboxId
      ) {
        throw notFoundException(SENDER_NOT_FOUND)
      }
      if (current.address !== grant.email) {
        throw emailSenderGoogleMismatchException(current.address)
      }
      const [updated] = await tx
        .update(emailSenderModel)
        .set({
          secret: await encryptEmailSenderGoogleSecret(secretOf(), current.id),
          tokenVersion: current.tokenVersion + 1,
          tokenRefreshedAt: new Date(),
          ...(current.status === "disconnected"
            ? { status: "active" as const, disconnectionReason: null }
            : {}),
        })
        .where(eq(emailSenderModel.id, current.id))
        .returning()
      return updated
    }

    let row: EmailSenderModel | undefined
    if (data.senderId) {
      row = await this.withLockedSender(
        data.workspaceId,
        data.senderId,
        reconnectRow,
      )
    } else {
      const id = createId()
      const secret = await encryptEmailSenderGoogleSecret(secretOf(), id)
      row = await db
        .transaction(async (tx) => {
          await this.lockLine(tx, data.lineInboxId)
          const [existing] = await tx
            .select()
            .from(emailSenderModel)
            .where(
              and(
                eq(emailSenderModel.lineInboxId, data.lineInboxId),
                eq(emailSenderModel.address, grant.email),
                ne(emailSenderModel.status, "archived"),
              ),
            )
            .for("update")
          if (existing) {
            if (existing.provider !== "google_oauth") {
              throw validationException(
                "address",
                "This address is already a sender on this email line",
              )
            }
            return await reconnectRow(tx, existing)
          }
          const [{ count = 0 } = {}] = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(emailSenderModel)
            .where(
              and(
                eq(emailSenderModel.lineInboxId, data.lineInboxId),
                ne(emailSenderModel.status, "archived"),
              ),
            )
          if (count >= EMAIL_SENDER_LIMITS.perLine) {
            throw validationException(
              "lineInboxId",
              `An email line holds at most ${EMAIL_SENDER_LIMITS.perLine} senders`,
            )
          }
          const [inserted] = await tx
            .insert(emailSenderModel)
            .values({
              id,
              workspaceId: data.workspaceId,
              lineInboxId: data.lineInboxId,
              provider: "google_oauth",
              address: grant.email,
              fromName: data.fromName as string,
              firstName: data.firstName as string,
              lastName: data.lastName as string,
              secret,
              status: "active",
              tokenVersion: 1,
              tokenRefreshedAt: new Date(),
            })
            .returning()
          return inserted
        })
        .catch((err: unknown) => {
          if (isUniqueViolationError(err)) {
            throw validationException(
              "address",
              "This address is already a sender on this email line",
            )
          }
          throw err
        })
    }
    if (!row) {
      throw new Error("email sender connect returned no row")
    }
    await this.audit(
      data.senderId ? "update" : "create",
      `connected Google mailbox sender #${row.id} on line #${row.lineInboxId}${userId ? ` by #${userId}` : ""}`,
    )
    return await this.toView(row)
  }

  /**
   * A Google sender's feed auth: its stored access token while it has more
   * than the margin left, else a refreshed one. Null when the sender is
   * disconnected or its secret is unreadable, or when the refresh failed and
   * the stored token has expired. Never throws (one sender never fails the
   * line's feed).
   */
  private async googleFeedAuth(row: EmailSenderModel): Promise<GoogleFeedAuth> {
    const none = { auth: null, disconnected: false }
    if (row.status === "disconnected") {
      return none
    }
    let secret: EmailSenderGoogleSecret
    try {
      secret = await decryptEmailSenderGoogleSecret(row)
    } catch {
      logger.error(
        { senderId: row.id },
        "email sender secret cannot be decrypted; fed with auth null",
      )
      return none
    }
    const feedAuth = (s: { accessToken: string; expiresAt: number }) => ({
      auth:
        s.expiresAt - Date.now() > GOOGLE_FEED_MIN_TOKEN_MS
          ? {
              type: "oauth2" as const,
              accessToken: s.accessToken,
              expiresAt: new Date(s.expiresAt).toISOString(),
            }
          : null,
      disconnected: false,
    })
    if (secret.expiresAt - Date.now() > GOOGLE_REFRESH_MARGIN_MS) {
      return feedAuth(secret)
    }
    let outlived = false
    const refresh = this.refreshGoogle(row.id)
    // A refresh that outlives the wait still settles (and stores) later; its
    // failure is logged here, since no caller waits for it any more.
    refresh.catch((err: unknown) => {
      if (outlived && !(err instanceof GoogleReconnectRequiredError)) {
        logger.warn(
          { senderId: row.id, err: err instanceof Error ? err.message : err },
          "google sender background token refresh failed",
        )
      }
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => {
        outlived = true
        resolve("late")
      }, GOOGLE_FEED_REFRESH_WAIT_MS)
    })
    try {
      const fresh = await Promise.race([refresh, late])
      if (fresh === "late") {
        logger.warn(
          { senderId: row.id },
          "google sender token refresh is slow; feeding the stored token",
        )
        return feedAuth(secret)
      }
      return fresh ? feedAuth(fresh) : none
    } catch (err) {
      if (err instanceof GoogleReconnectRequiredError) {
        return { auth: null, disconnected: true }
      }
      logger.warn(
        { senderId: row.id, err: err instanceof Error ? err.message : err },
        "google sender token refresh failed; feeding the stored token",
      )
      return feedAuth(secret)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Refreshes a Google sender's access token once, however many feeds ask
   * at the same time: a per-sender Redis lock, then a re-read (another
   * holder may have refreshed already), then a CAS on `tokenVersion` (a
   * reconnect that landed meanwhile wins). Google refusing the grant marks
   * the sender disconnected at the version it read; when a reconnect beat
   * that disconnect, the reconnect's grant is returned instead of the
   * refusal. Returns null when the sender is gone, archived or disconnected.
   */
  private async refreshGoogle(
    id: string,
  ): Promise<EmailSenderGoogleSecret | null> {
    return await distributedLock.runExclusive({
      key: `email-sender:refresh:${id}`,
      timeoutInSeconds: GOOGLE_REFRESH_LOCK_SECONDS,
      fn: async () => {
        const [row] = await db
          .select()
          .from(emailSenderModel)
          .where(eq(emailSenderModel.id, id))
          .limit(1)
        if (
          row?.provider !== "google_oauth" ||
          row.status === "archived" ||
          row.status === "disconnected"
        ) {
          return null
        }
        const secret = await decryptEmailSenderGoogleSecret(row)
        if (secret.expiresAt - Date.now() > GOOGLE_REFRESH_MARGIN_MS) {
          return secret
        }
        const client = await this.googleClient(secret.ownerId)
        if (!client) {
          throw new Error("the Google app is not configured")
        }
        // The grant held at `row.tokenVersion` is dead: disconnect at that
        // version, or (a reconnect won) feed the newer grant.
        const refused = async (reason: string) => {
          if (await this.markDisconnected(id, row.tokenVersion, reason)) {
            throw new GoogleReconnectRequiredError(reason)
          }
          return await this.currentGoogleSecret(id)
        }
        if (client.clientId !== secret.clientId) {
          return await refused(GOOGLE_APP_CHANGED_REASON)
        }
        let fresh: Awaited<ReturnType<typeof refreshGoogleAccessToken>>
        try {
          fresh = await refreshGoogleAccessToken({
            client,
            refreshToken: secret.refreshToken,
          })
        } catch (err) {
          if (err instanceof GoogleReconnectRequiredError) {
            return await refused(GOOGLE_REVOKED_REASON)
          }
          throw err
        }
        const next: EmailSenderGoogleSecret = {
          ...secret,
          accessToken: fresh.accessToken,
          expiresAt: fresh.expiresAt,
          refreshToken: fresh.refreshToken ?? secret.refreshToken,
        }
        const [saved] = await db
          .update(emailSenderModel)
          .set({
            secret: await encryptEmailSenderGoogleSecret(next, id),
            tokenVersion: row.tokenVersion + 1,
            tokenRefreshedAt: new Date(),
          })
          .where(
            and(
              eq(emailSenderModel.id, id),
              eq(emailSenderModel.tokenVersion, row.tokenVersion),
              // An archive or disconnect that landed while Google answered
              // keeps its row: no token is written into it (probe s230b).
              notInArray(emailSenderModel.status, ["archived", "disconnected"]),
            ),
          )
          .returning({ id: emailSenderModel.id })
        if (saved) {
          return next
        }
        // A reconnect (its grant wins), an archive or a disconnect landed
        // while Google answered.
        return await this.currentGoogleSecret(id)
      },
    })
  }

  /** The sender's stored grant, or null when it is gone, archived or disconnected. */
  private async currentGoogleSecret(
    id: string,
  ): Promise<EmailSenderGoogleSecret | null> {
    const [current] = await db
      .select()
      .from(emailSenderModel)
      .where(eq(emailSenderModel.id, id))
      .limit(1)
    return current?.provider === "google_oauth" &&
      current.status !== "archived" &&
      current.status !== "disconnected"
      ? await decryptEmailSenderGoogleSecret(current)
      : null
  }

  /**
   * The system's disconnect (s230b): Google refused the grant the sender
   * held at `seenVersion`. Lands only if no reconnect or refresh wrote a
   * newer grant since, and never on an archived sender. Same lock order as
   * every writer (line lock, then the row FOR UPDATE). True when it landed.
   */
  private async markDisconnected(
    id: string,
    seenVersion: number,
    reason: string,
  ): Promise<boolean> {
    const landed = await db.transaction(async (tx) => {
      const [line] = await tx
        .select({ lineInboxId: emailSenderModel.lineInboxId })
        .from(emailSenderModel)
        .where(eq(emailSenderModel.id, id))
        .limit(1)
      if (!line) {
        return false
      }
      await this.lockLine(tx, line.lineInboxId)
      const [current] = await tx
        .select({
          status: emailSenderModel.status,
          tokenVersion: emailSenderModel.tokenVersion,
        })
        .from(emailSenderModel)
        .where(eq(emailSenderModel.id, id))
        .for("update")
      if (
        !current ||
        current.status === "archived" ||
        current.tokenVersion !== seenVersion
      ) {
        return false
      }
      await tx
        .update(emailSenderModel)
        .set({ status: "disconnected", disconnectionReason: reason })
        .where(eq(emailSenderModel.id, id))
      return true
    })
    if (landed) {
      logger.warn({ senderId: id }, "google email sender disconnected")
      await this.audit("update", `disconnected email sender #${id}: ${reason}`)
    }
    return landed
  }

  /** The owner's Google app (the tenant's own, else the platform's). */
  private async googleClient(
    ownerId: string,
  ): Promise<GoogleOAuthClient | null> {
    const credential = await platformCredentialService.resolveForOwner({
      ownerId,
      type: "google",
    })
    const config = credential?.config
    return config?.clientId && config.clientSecret
      ? { clientId: config.clientId, clientSecret: config.clientSecret }
      : null
  }

  /**
   * The sender of a NEW thread on this line (wire contract sec. 4). Called
   * inside the caller's (contact, line) transaction; it then takes the
   * LINE-wide advisory lock (lock order: contact lock, line lock, rows), so
   * the day's counts are serialized per line and no status write lands
   * before the plan commits. Null when the line has no non-archived sender (the
   * legacy env account); else the `active` sender with the fewest outgoing
   * mails since UTC midnight, ties to the smallest id. Throws
   * EmailSenderUnavailableError when senders exist but none is active.
   */
  async pickForNewThread(
    tx: DatabaseClient,
    props: { workspaceId: string; lineInboxId: string; now?: Date },
  ): Promise<string | null> {
    if (
      !props ||
      typeof props.workspaceId !== "string" ||
      typeof props.lineInboxId !== "string" ||
      !EMAIL_SENDER_ID.test(props.workspaceId) ||
      !EMAIL_SENDER_ID.test(props.lineInboxId)
    ) {
      throw new TypeError(
        "pickForNewThread needs a workspaceId and lineInboxId",
      )
    }
    await this.lockLine(tx, props.lineInboxId)
    const since = utcMidnight(props.now ?? new Date())
    const rows = await tx
      .select({
        id: emailSenderModel.id,
        status: emailSenderModel.status,
        sent: sql<number>`count(${emailThreadMailModel.id})::int`,
      })
      .from(emailSenderModel)
      .leftJoin(
        emailThreadMailModel,
        and(
          eq(emailThreadMailModel.senderId, emailSenderModel.id),
          eq(emailThreadMailModel.direction, "outgoing"),
          gte(emailThreadMailModel.createdAt, since),
        ),
      )
      .where(
        and(
          eq(emailSenderModel.workspaceId, props.workspaceId),
          eq(emailSenderModel.lineInboxId, props.lineInboxId),
          ne(emailSenderModel.status, "archived"),
        ),
      )
      .groupBy(emailSenderModel.id, emailSenderModel.status)
    if (rows.length === 0) {
      return null
    }
    const active = rows
      .filter((r) => r.status === "active")
      .sort((a, b) => {
        if (a.sent !== b.sent) {
          return a.sent - b.sent
        }
        return BigInt(a.id) < BigInt(b.id) ? -1 : 1
      })
    const chosen = active[0]
    if (!chosen) {
      throw new EmailSenderUnavailableError("no-active-sender")
    }
    return chosen.id
  }

  /**
   * A thread's sticky sender must still exist on the line and not be
   * archived (wire contract sec. 4), read under a row lock held until the
   * caller's transaction ends; paused / draining / disconnected are the
   * daemon's to hold. Throws EmailSenderUnavailableError otherwise.
   */
  async assertThreadSender(
    tx: DatabaseClient,
    props: { workspaceId: string; lineInboxId: string; senderId: string },
  ): Promise<void> {
    if (
      !props ||
      typeof props.senderId !== "string" ||
      !EMAIL_SENDER_ID.test(props.senderId)
    ) {
      throw new EmailSenderUnavailableError("sender-removed")
    }
    const [row] = await tx
      .select({ status: emailSenderModel.status })
      .from(emailSenderModel)
      .where(
        and(
          eq(emailSenderModel.id, props.senderId),
          eq(emailSenderModel.workspaceId, props.workspaceId),
          eq(emailSenderModel.lineInboxId, props.lineInboxId),
        ),
      )
      // FOR SHARE until the plan commits: an archive (FOR UPDATE) waits for
      // it, or this read waits for the archive and sees it (review s229b).
      .for("share")
    if (!row || row.status === "archived") {
      throw new EmailSenderUnavailableError("sender-removed")
    }
  }

  private async assertLine(workspaceId: string, lineInboxId: string) {
    const [inbox] = await db
      .select({
        channel: inboxModel.channel,
        lineKind: integrationApiModel.lineKind,
      })
      .from(inboxModel)
      .leftJoin(
        integrationApiModel,
        eq(integrationApiModel.inboxId, inboxModel.id),
      )
      .where(
        and(
          eq(inboxModel.id, lineInboxId),
          eq(inboxModel.workspaceId, workspaceId),
        ),
      )
      .limit(1)
    if (!inbox) {
      throw notFoundException("Email line not found")
    }
    if (inbox.channel !== "api" || inbox.lineKind !== "email") {
      throw validationException(
        "lineInboxId",
        "Senders belong to an email line (an API channel marked as one)",
      )
    }
  }

  /** s231b: whether this inbox is an API channel marked as an email line. */
  private async isEmailLine(workspaceId: string, lineInboxId: string) {
    const [row] = await db
      .select({ id: integrationApiModel.id })
      .from(integrationApiModel)
      .where(
        and(
          eq(integrationApiModel.inboxId, lineInboxId),
          eq(integrationApiModel.workspaceId, workspaceId),
          eq(integrationApiModel.lineKind, "email"),
        ),
      )
      .limit(1)
    return row !== undefined
  }

  private async lockLine(tx: DatabaseClient, lineInboxId: string) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`email-sender:${lineInboxId}`}, 0))`,
    )
  }

  /**
   * Runs `fn` on the sender's row under the lock order every writer and
   * planner shares (review s229b): the line advisory lock first, then the
   * row FOR UPDATE. A thread plan holds the (contact, line) lock, then the
   * line lock (a new thread) or the row FOR SHARE (a follow-up), so a status
   * write either waits for the plan's commit or the plan sees the new
   * status. `lineInboxId` never changes, so reading it unlocked is safe.
   * 404 for a missing, foreign or archived sender.
   */
  private async withLockedSender(
    workspaceId: string,
    id: string,
    fn: (
      tx: DatabaseClient,
      current: EmailSenderModel,
    ) => Promise<EmailSenderModel | undefined>,
  ): Promise<EmailSenderModel> {
    const row = await db.transaction(async (tx) => {
      const [line] = await tx
        .select({ lineInboxId: emailSenderModel.lineInboxId })
        .from(emailSenderModel)
        .where(
          and(
            eq(emailSenderModel.id, id),
            eq(emailSenderModel.workspaceId, workspaceId),
          ),
        )
        .limit(1)
      if (!line) {
        return
      }
      await this.lockLine(tx, line.lineInboxId)
      const [current] = await tx
        .select()
        .from(emailSenderModel)
        .where(
          and(
            eq(emailSenderModel.id, id),
            eq(emailSenderModel.workspaceId, workspaceId),
          ),
        )
        .for("update")
      if (!current || current.status === "archived") {
        return
      }
      return await fn(tx, current)
    })
    if (!row) {
      throw notFoundException(SENDER_NOT_FOUND)
    }
    return row
  }

  /** The encrypted secret an update stores; blank passwords keep the stored one. */
  private async nextSecret(
    current: EmailSenderModel,
    connection: {
      smtp: Omit<EmailSenderSmtpSecret["smtp"], "password"> & {
        password?: string
      }
      imap: Omit<EmailSenderSmtpSecret["imap"], "password"> & {
        password?: string
      }
    },
  ): Promise<unknown> {
    const needsStored = !(connection.smtp.password && connection.imap.password)
    const stored = needsStored
      ? await decryptEmailSenderSecret(current).catch(() => {
          throw validationException(
            "connection",
            "The stored password cannot be read: enter the password again",
          )
        })
      : null
    const next: EmailSenderSmtpSecret = {
      smtp: {
        ...connection.smtp,
        password: connection.smtp.password || (stored?.smtp.password as string),
      },
      imap: {
        ...connection.imap,
        password: connection.imap.password || (stored?.imap.password as string),
      },
    }
    assertOnePassword(next)
    return await encryptEmailSenderSecret(next, current.id)
  }

  private async toView(row: EmailSenderModel): Promise<EmailSenderView> {
    const { secret: _secret, ...rest } = row
    let connection: EmailSenderConnection | null = null
    if (row.provider === "smtp") {
      try {
        connection = connectionOf(await decryptEmailSenderSecret(row))
      } catch {
        connection = null
      }
    }
    return { ...rest, connection }
  }
}

export const emailSenderService = new EmailSenderService()
