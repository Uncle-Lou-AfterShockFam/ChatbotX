import {
  and,
  type DatabaseClient,
  db,
  desc,
  eq,
  inArray,
  sql,
} from "@chatbotx.io/database/client"
import { EMAIL_SENDER_ID } from "@chatbotx.io/database/partials"
import {
  emailSenderModel,
  emailThreadMailModel,
} from "@chatbotx.io/database/schema"
import type { EmailThreadMailModel } from "@chatbotx.io/database/types"
import { createId } from "@chatbotx.io/utils"
import { BaseService } from "../base.service"

/**
 * The most ids a mail's References carry: the line's cap (bulktext
 * EMAIL_DOC_LIMITS.threadKeys, the worker's LINE_EMAIL_LIMITS.threadKeys).
 * Past it, the root and the newest are kept (what mail clients thread on).
 */
export const EMAIL_THREAD_MAX_REFS = 20

type LineRef = {
  workspaceId: string
  contactId: string
  lineInboxId: string
}

/** Which earlier mails a thread lookup considers; `{}` = any on the line. */
export type ThreadScope =
  | { sequenceId: string }
  | { broadcastId: string }
  | { flowId: string }
  | Record<string, never>

type Source = {
  sequenceId?: string | null
  broadcastId?: string | null
  flowId?: string | null
}

/** A hub key cited as `<key@domain>` (the line appends its own domain). */
const CITED_KEY = /^<([^@<>]+)@[^<>]+>$/

/**
 * A full RFC 5322 msg-id another mailer minted, strictly `<dot-atom@host>`:
 * the SAME grammar and cap the line enforces (bulktext `isCitableMsgId`), so
 * a thread never cites an id the line would refuse. Inbound attributes come
 * from any API-channel caller: nothing else is stored.
 */
const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+"
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
const FOREIGN_MSG_ID = new RegExp(
  `^<${ATEXT}(?:\\.${ATEXT})*@${LABEL}(?:\\.${LABEL})*>$`,
)
export const EMAIL_MSG_ID_MAX = 250
/** The most chars a stored subject keeps (RFC 5322's line cap). */
export const EMAIL_SUBJECT_MAX = 998

export function isCitableMsgId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length <= EMAIL_MSG_ID_MAX &&
    FOREIGN_MSG_ID.test(id)
  )
}

/** The automatic-answer classes a bulktext email line flags (s226b, s228b). */
export const AUTO_REPLY_CLASSES = ["ooo", "auto"] as const
export type AutoReplyClass = (typeof AUTO_REPLY_CLASSES)[number]

/**
 * The automatic-answer class the bulktext email line flagged on an inbound
 * mail (`contentAttributes.email.autoReply`): "ooo" = an out-of-office (a
 * sequence pauses on it, s226b), "auto" = any other automatic answer, e.g. a
 * ticket acknowledgement (s228b: never a reply, never a pause). Anything else
 * is undefined: a person wrote it.
 */
export function autoReplyClass(
  contentAttributes: unknown,
): AutoReplyClass | undefined {
  const email =
    typeof contentAttributes === "object" && contentAttributes !== null
      ? (contentAttributes as { email?: unknown }).email
      : undefined
  const value =
    typeof email === "object" && email !== null
      ? (email as { autoReply?: unknown }).autoReply
      : undefined
  return AUTO_REPLY_CLASSES.find((c) => c === value)
}

/** True for an out-of-office answer (s226b): a sequence pauses on it. */
export function isOutOfOffice(contentAttributes: unknown): boolean {
  return autoReplyClass(contentAttributes) === "ooo"
}

export type InboundEmailAttributes = {
  messageId: string
  subject: string
  references: string[]
  /**
   * s229b: the EmailSender whose mailbox the line read this mail from
   * (`email.sender`); absent for the line's env account or a malformed id.
   */
  sender?: string
}

/**
 * The thread facts of an inbound line mail (`contentAttributes.email`, set by
 * the bulktext email line, s226b), or null when it is not one a thread may
 * reply under: no citable id, or an automatic answer (an out-of-office is
 * never a thread parent). Uncitable references are dropped, never stored;
 * at most EMAIL_THREAD_MAX_REFS, the newest kept.
 */
export function inboundEmailAttributes(
  contentAttributes: unknown,
): InboundEmailAttributes | null {
  if (typeof contentAttributes !== "object" || contentAttributes === null) {
    return null
  }
  const email = (contentAttributes as { email?: unknown }).email
  if (typeof email !== "object" || email === null) {
    return null
  }
  const { messageId, subject, references, autoReply, sender } = email as Record<
    string,
    unknown
  >
  if (!isCitableMsgId(messageId) || autoReply !== undefined) {
    return null
  }
  const refs = Array.isArray(references)
    ? [...new Set(references.filter(isCitableMsgId))]
        .filter((ref) => ref !== messageId)
        .slice(-EMAIL_THREAD_MAX_REFS)
    : []
  return {
    messageId,
    subject:
      typeof subject === "string" ? subject.slice(0, EMAIL_SUBJECT_MAX) : "",
    references: refs,
    ...(typeof sender === "string" && EMAIL_SENDER_ID.test(sender)
      ? { sender }
      : {}),
  }
}

/**
 * Outreach B-1 PR 3 (s226b): the mails exchanged with a contact on an email
 * line, in both directions, so an email step can reply under an earlier one.
 */
export class EmailThreadMailService extends BaseService {
  /**
   * Runs `fn` in a transaction holding this (contact, line)'s advisory lock
   * (Codex s226b): two sends planning at once would both find no parent and
   * start two threads; serialized, the second sees the first's row.
   */
  withLineLock<T>(
    props: LineRef,
    fn: (tx: DatabaseClient) => Promise<T>,
  ): Promise<T> {
    const key = `email-thread:${props.workspaceId}:${props.contactId}:${props.lineInboxId}`
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
      )
      return fn(tx)
    })
  }

  /**
   * Records a mail the line QUEUED. Idempotent on its key: a retried job
   * derives the same key and records nothing new (null).
   */
  async recordOutgoing(
    props: LineRef &
      Source & {
        messageKey: string
        subject: string
        /** What the mail cites, oldest first (see the model). */
        parents: string[]
        /** s229b: the mailbox it goes out from; null = the env account. */
        senderId?: string | null
        tx?: DatabaseClient
      },
  ): Promise<EmailThreadMailModel | null> {
    const { tx = db } = props
    const [row] = await tx
      .insert(emailThreadMailModel)
      .values({
        id: createId(),
        direction: "outgoing",
        messageKey: props.messageKey,
        subject: props.subject,
        parents: props.parents,
        workspaceId: props.workspaceId,
        contactId: props.contactId,
        lineInboxId: props.lineInboxId,
        sequenceId: props.sequenceId ?? null,
        broadcastId: props.broadcastId ?? null,
        flowId: props.flowId ?? null,
        senderId: props.senderId ?? null,
      })
      .onConflictDoNothing()
      .returning()
    return row ?? null
  }

  /**
   * Records the contact's own mail (its RFC id and what it cited). A mail
   * that cites one of OUR keys inherits that mail's campaign, so `previous`
   * and `campaign` follow the contact's latest answer in that thread. Keys
   * are matched only among this contact's mails on this line. Idempotent on
   * the mail's id (null when already recorded). s229b: its sender is the
   * line's `sender` it arrived in when that id IS a sender of this line
   * (a foreign id is ignored), else the cited outgoing parent's.
   */
  async recordIncoming(
    props: LineRef & InboundEmailAttributes & { tx?: DatabaseClient },
  ): Promise<EmailThreadMailModel | null> {
    const { tx = db } = props
    if (!isCitableMsgId(props.messageId)) {
      return null
    }
    const cited = props.references
      .map((ref) => CITED_KEY.exec(ref)?.[1])
      .filter((key): key is string => Boolean(key))
    const [parent] = cited.length
      ? await tx
          .select()
          .from(emailThreadMailModel)
          .where(
            and(
              this.lineWhere(props),
              eq(emailThreadMailModel.direction, "outgoing"),
              inArray(emailThreadMailModel.messageKey, cited),
            ),
          )
          .orderBy(desc(emailThreadMailModel.createdAt))
          .limit(1)
      : []
    const [own] = props.sender
      ? await tx
          .select({ id: emailSenderModel.id })
          .from(emailSenderModel)
          .where(
            and(
              eq(emailSenderModel.id, props.sender),
              eq(emailSenderModel.workspaceId, props.workspaceId),
              eq(emailSenderModel.lineInboxId, props.lineInboxId),
            ),
          )
          .limit(1)
      : []
    const [row] = await tx
      .insert(emailThreadMailModel)
      .values({
        id: createId(),
        direction: "incoming",
        messageId: props.messageId,
        subject: props.subject,
        parents: props.references.filter((ref) => ref !== props.messageId),
        workspaceId: props.workspaceId,
        contactId: props.contactId,
        lineInboxId: props.lineInboxId,
        sequenceId: parent?.sequenceId ?? null,
        broadcastId: parent?.broadcastId ?? null,
        flowId: parent?.flowId ?? null,
        senderId: own?.id ?? parent?.senderId ?? null,
      })
      .onConflictDoNothing()
      .returning()
    return row ?? null
  }

  /**
   * Forgets an outgoing mail that will never be sent (its send failed for
   * good, skeptic s226b), so no later step replies under it. Kept when a
   * later mail already cites it: that mail's References stay whole. Runs
   * under the line lock, so no plan can pick it up meanwhile.
   */
  forgetOutgoing(props: LineRef & { messageKey: string }): Promise<void> {
    return this.withLineLock(props, async (tx) => {
      await tx.execute(sql`
        DELETE FROM ${emailThreadMailModel}
        WHERE ${emailThreadMailModel.workspaceId} = ${props.workspaceId}
          AND ${emailThreadMailModel.contactId} = ${props.contactId}
          AND ${emailThreadMailModel.lineInboxId} = ${props.lineInboxId}
          AND ${emailThreadMailModel.direction} = 'outgoing'
          AND ${emailThreadMailModel.messageKey} = ${props.messageKey}
          AND NOT EXISTS (
            SELECT 1 FROM ${emailThreadMailModel} child
            WHERE child."workspaceId" = ${props.workspaceId}
              AND child."lineInboxId" = ${props.lineInboxId}
              AND ${props.messageKey} = ANY (child.parents)
          )`)
    })
  }

  /** The outgoing mail a (retried) send already recorded under this key. */
  async findByKey(
    props: LineRef & { messageKey: string; tx?: DatabaseClient },
  ): Promise<EmailThreadMailModel | null> {
    const { tx = db } = props
    const [row] = await tx
      .select()
      .from(emailThreadMailModel)
      .where(
        and(
          this.lineWhere(props),
          eq(emailThreadMailModel.messageKey, props.messageKey),
        ),
      )
      .limit(1)
    return row ?? null
  }

  /** The newest mail on this line with the contact, optionally in one campaign. */
  async latest(
    props: LineRef & { scope: ThreadScope; tx?: DatabaseClient },
  ): Promise<EmailThreadMailModel | null> {
    const { tx = db, scope } = props
    const [row] = await tx
      .select()
      .from(emailThreadMailModel)
      .where(and(this.lineWhere(props), this.scopeWhere(scope)))
      .orderBy(
        desc(emailThreadMailModel.createdAt),
        desc(emailThreadMailModel.id),
      )
      .limit(1)
    return row ?? null
  }

  private lineWhere(props: LineRef) {
    return and(
      eq(emailThreadMailModel.workspaceId, props.workspaceId),
      eq(emailThreadMailModel.contactId, props.contactId),
      eq(emailThreadMailModel.lineInboxId, props.lineInboxId),
    )
  }

  private scopeWhere(scope: ThreadScope) {
    if ("sequenceId" in scope) {
      return eq(emailThreadMailModel.sequenceId, scope.sequenceId)
    }
    if ("broadcastId" in scope) {
      return eq(emailThreadMailModel.broadcastId, scope.broadcastId)
    }
    if ("flowId" in scope) {
      return eq(emailThreadMailModel.flowId, scope.flowId)
    }
    return
  }
}

export const emailThreadMailService = new EmailThreadMailService()
