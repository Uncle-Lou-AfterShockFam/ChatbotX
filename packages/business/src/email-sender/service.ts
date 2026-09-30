import {
  and,
  asc,
  type DatabaseClient,
  db,
  eq,
  gte,
  isUniqueViolationError,
  ne,
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
} from "@chatbotx.io/database/schema"
import type { EmailSenderModel } from "@chatbotx.io/database/types"
import { createId } from "@chatbotx.io/utils"
import { BaseService } from "../base.service"
import {
  emailSenderCredentialsRequiredException,
  notFoundException,
  validationException,
} from "../errors"
import { logger } from "../logger"
import {
  createEmailSenderInput,
  emailSenderLineInput,
  emailSenderRefInput,
  listEmailSendersInput,
  parseInput,
  setEmailSenderStatusInput,
  updateEmailSenderInput,
} from "./schema"
import {
  connectionOf,
  decryptEmailSenderSecret,
  type EmailSenderConnection,
  type EmailSenderSmtpSecret,
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
  auth: { type: "password"; password: string } | null
}

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
    return await db
      .select({ id: inboxModel.id, name: inboxModel.name })
      .from(inboxModel)
      .where(
        and(
          eq(inboxModel.workspaceId, workspaceId),
          eq(inboxModel.channel, "api"),
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
   * A blank (or absent) password keeps the stored one. A NEW password
   * reconnects a disconnected sender (status active, reason cleared); it
   * leaves any other status as it is.
   */
  async update(input: unknown): Promise<EmailSenderView> {
    const { workspaceId, id, connection, ...fields } = parseInput(
      updateEmailSenderInput,
      input,
    )
    const current = await this.findLive(workspaceId, id)
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
    let secret: unknown
    if (connection) {
      const needsStored = !(
        connection.smtp.password && connection.imap.password
      )
      const stored = needsStored
        ? await decryptEmailSenderSecret(current).catch(() => {
            throw validationException(
              "connection",
              "The stored password cannot be read: enter both passwords again",
            )
          })
        : null
      const next: EmailSenderSmtpSecret = {
        smtp: {
          ...connection.smtp,
          password:
            connection.smtp.password || (stored?.smtp.password as string),
        },
        imap: {
          ...connection.imap,
          password:
            connection.imap.password || (stored?.imap.password as string),
        },
      }
      assertOnePassword(next)
      secret = await encryptEmailSenderSecret(next, id)
    }
    const reconnect = Boolean(
      connection && (connection.smtp.password || connection.imap.password),
    )
    const [row] = await db
      .update(emailSenderModel)
      .set({
        ...fields,
        ...(secret ? { secret } : {}),
        ...(reconnect
          ? {
              status: sql`CASE WHEN ${emailSenderModel.status} = 'disconnected' THEN 'active' ELSE ${emailSenderModel.status} END`,
              disconnectionReason: null,
            }
          : {}),
      })
      .where(
        and(
          eq(emailSenderModel.id, id),
          eq(emailSenderModel.workspaceId, workspaceId),
          ne(emailSenderModel.status, "archived"),
        ),
      )
      .returning()
    if (!row) {
      throw notFoundException(SENDER_NOT_FOUND)
    }
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
    const [row] = await db
      .update(emailSenderModel)
      .set({ status })
      .where(
        and(
          eq(emailSenderModel.id, id),
          eq(emailSenderModel.workspaceId, workspaceId),
          ne(emailSenderModel.status, "archived"),
          ne(emailSenderModel.status, "disconnected"),
        ),
      )
      .returning()
    if (!row) {
      const current = await this.findLive(workspaceId, id)
      if (current.status === "disconnected") {
        throw emailSenderCredentialsRequiredException()
      }
      // Changed between the update and this read: the caller retries.
      throw notFoundException(SENDER_NOT_FOUND)
    }
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
    const [row] = await db
      .update(emailSenderModel)
      .set({ status: "archived" })
      .where(
        and(
          eq(emailSenderModel.id, id),
          eq(emailSenderModel.workspaceId, workspaceId),
          ne(emailSenderModel.status, "archived"),
        ),
      )
      .returning({ id: emailSenderModel.id })
    if (!row) {
      throw notFoundException(SENDER_NOT_FOUND)
    }
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
        // Gmail over OAuth: tokens arrive with PR 3; not usable now (null).
        const { smtp, imap } = GMAIL_APP_PASSWORD_PRESET
        feed.push({
          ...base,
          smtp: { ...smtp, user: row.address },
          imap: { ...imap, user: row.address },
          auth: null,
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
   * The sender of a NEW thread on this line (wire contract sec. 4), under the
   * caller's line lock: null when the line has no non-archived sender (the
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
   * archived (wire contract sec. 4); paused / draining / disconnected are the
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
      .limit(1)
    if (!row || row.status === "archived") {
      throw new EmailSenderUnavailableError("sender-removed")
    }
  }

  private async assertLine(workspaceId: string, lineInboxId: string) {
    const [inbox] = await db
      .select({ channel: inboxModel.channel })
      .from(inboxModel)
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
    if (inbox.channel !== "api") {
      throw validationException(
        "lineInboxId",
        "Senders belong to an email line (an API-channel inbox)",
      )
    }
  }

  private async lockLine(tx: DatabaseClient, lineInboxId: string) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`email-sender:${lineInboxId}`}, 0))`,
    )
  }

  private async findLive(
    workspaceId: string,
    id: string,
  ): Promise<EmailSenderModel> {
    const [row] = await db
      .select()
      .from(emailSenderModel)
      .where(
        and(
          eq(emailSenderModel.id, id),
          eq(emailSenderModel.workspaceId, workspaceId),
          ne(emailSenderModel.status, "archived"),
        ),
      )
      .limit(1)
    if (!row) {
      throw notFoundException(SENDER_NOT_FOUND)
    }
    return row
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
