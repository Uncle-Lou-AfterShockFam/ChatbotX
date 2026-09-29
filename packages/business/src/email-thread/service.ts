import {
  and,
  type DatabaseClient,
  db,
  eq,
  sql,
} from "@chatbotx.io/database/client"
import { emailThreadModel } from "@chatbotx.io/database/schema"
import type { EmailThreadModel } from "@chatbotx.io/database/types"
import { createId } from "@chatbotx.io/utils"
import { BaseService } from "../base.service"

/**
 * The most keys a thread keeps; equal to the line's ancestor cap
 * (`LINE_EMAIL_LIMITS.threadKeys` in the worker, bulktext EMAIL_DOC_LIMITS): the root
 * plus the newest ones. Older middle keys drop out of References; the root
 * and In-Reply-To are what clients thread on.
 */
export const EMAIL_THREAD_MAX_KEYS = 20

type ThreadRef = {
  workspaceId: string
  contactId: string
  sequenceId: string
}

export class EmailThreadService extends BaseService {
  /** The contact's thread in this sequence, or null before its first mail. */
  async find(
    props: ThreadRef & { tx?: DatabaseClient },
  ): Promise<EmailThreadModel | null> {
    const { tx = db } = props
    const [row] = await tx
      .select()
      .from(emailThreadModel)
      .where(
        and(
          eq(emailThreadModel.workspaceId, props.workspaceId),
          eq(emailThreadModel.contactId, props.contactId),
          eq(emailThreadModel.sequenceId, props.sequenceId),
        ),
      )
      .limit(1)
    return row ?? null
  }

  /**
   * Claims the thread's ROOT before its first mail is queued (Codex s225b:
   * two concurrent first sends must not both start a thread, least of all
   * from two lines). Null = another send already owns the thread: re-read it
   * and follow up instead.
   */
  async claimRoot(
    props: ThreadRef & {
      lineInboxId: string
      subject: string
      key: string
      tx?: DatabaseClient
    },
  ): Promise<EmailThreadModel | null> {
    const { tx = db } = props
    const [row] = await tx
      .insert(emailThreadModel)
      .values({
        id: createId(),
        workspaceId: props.workspaceId,
        contactId: props.contactId,
        sequenceId: props.sequenceId,
        lineInboxId: props.lineInboxId,
        subject: props.subject,
        keys: [props.key],
      })
      .onConflictDoNothing({
        target: [
          emailThreadModel.workspaceId,
          emailThreadModel.contactId,
          emailThreadModel.sequenceId,
        ],
      })
      .returning()
    return row ?? null
  }

  /**
   * Gives a claimed root back when its mail was never queued, so the next
   * attempt starts the thread again. Only while the root is the thread's
   * ONLY key: once a follow-up joined, the thread stays.
   */
  async releaseRoot(
    props: ThreadRef & { key: string; tx?: DatabaseClient },
  ): Promise<void> {
    const { tx = db } = props
    await tx
      .delete(emailThreadModel)
      .where(
        and(
          eq(emailThreadModel.workspaceId, props.workspaceId),
          eq(emailThreadModel.contactId, props.contactId),
          eq(emailThreadModel.sequenceId, props.sequenceId),
          sql`${emailThreadModel.keys} = ARRAY[${props.key}::text]`,
        ),
      )
  }

  /**
   * Records a mail the line QUEUED under this thread, in ONE statement (no
   * read-then-write race): the first mail creates the thread with its
   * subject; a later one appends its key, keeping the root plus the newest
   * keys within EMAIL_THREAD_MAX_KEYS. A thread started on another line is
   * never touched (null): its keys only resolve on that line's domain.
   */
  async recordSent(
    props: ThreadRef & {
      lineInboxId: string
      subject: string
      key: string
      tx?: DatabaseClient
    },
  ): Promise<EmailThreadModel | null> {
    const { tx = db } = props
    const keep = EMAIL_THREAD_MAX_KEYS - 2
    const [row] = await tx
      .insert(emailThreadModel)
      .values({
        id: createId(),
        workspaceId: props.workspaceId,
        contactId: props.contactId,
        sequenceId: props.sequenceId,
        lineInboxId: props.lineInboxId,
        subject: props.subject,
        keys: [props.key],
      })
      .onConflictDoUpdate({
        target: [
          emailThreadModel.workspaceId,
          emailThreadModel.contactId,
          emailThreadModel.sequenceId,
        ],
        set: {
          keys: sql`CASE
            WHEN ${props.key} = ANY(${emailThreadModel.keys}) THEN ${emailThreadModel.keys}
            WHEN cardinality(${emailThreadModel.keys}) < ${EMAIL_THREAD_MAX_KEYS} THEN array_append(${emailThreadModel.keys}, ${props.key}::text)
            ELSE ${emailThreadModel.keys}[1:1] || ${emailThreadModel.keys}[cardinality(${emailThreadModel.keys}) - ${keep - 1}:] || ARRAY[${props.key}::text]
          END`,
        },
        setWhere: eq(emailThreadModel.lineInboxId, props.lineInboxId),
      })
      .returning()
    return row ?? null
  }
}

export const emailThreadService = new EmailThreadService()
