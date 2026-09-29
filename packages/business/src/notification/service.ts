import {
  and,
  type DatabaseClient,
  db,
  desc,
  eq,
  inArray,
  isNull,
  sql,
} from "@chatbotx.io/database/client"
import {
  type DealNotificationPayload,
  MAX_NOTIFICATION_PAGE,
  type NotificationPayload,
  type NotificationType,
} from "@chatbotx.io/database/partials"
import {
  dealCommentMentionModel,
  dealModel,
  notificationModel,
} from "@chatbotx.io/database/schema"
import type {
  FormSubmissionModel,
  NotificationModel,
} from "@chatbotx.io/database/types"
import { RealtimeEventType } from "@chatbotx.io/partysocket-config"
import { createId } from "@chatbotx.io/utils"
import {
  NotificationJobAction,
  notificationQueue,
} from "@chatbotx.io/worker-config"
import { BaseService } from "../base.service"
import { logger } from "../logger"
import { canViewPipeline, viewerOwnerFilter } from "../pipeline/access"
import { pipelineService } from "../pipeline/service"
import { sendToWorkspaceMember } from "../platform/realtime-broadcast"
import { resolveMemberNotificationPrefs } from "../workspace-member/notification-prefs"
import {
  assignedOnlyUserId,
  hasContactsAccess,
} from "../workspace-member/permissions"
import { workspaceMemberService } from "../workspace-member/service"

/**
 * Unread rows sort first; the rank rides in the cursor so a mark-read between
 * pages cannot flip it. A function, not a module constant: the business
 * barrel is imported by tests that mock the database client without `sql`.
 */
const unreadRankExpr = () =>
  sql<number>`case when ${notificationModel.readAt} is null then 1 else 0 end`
const CURSOR = /^([01]):(\d{1,30})$/

export type NotifyInput = {
  workspaceId: string
  userId: string
  type: Exclude<NotificationType, "formSubmitted">
  dealId: string
  taskId?: string | null
  commentId?: string | null
  payload: DealNotificationPayload
}

/** One submission, the members a form's `notifyUsers` action names (s220). */
export type NotifyFormSubmissionInput = {
  workspaceId: string
  contactId: string
  userIds: string[]
  formId: string
  formTitle: string
  submission: Pick<FormSubmissionModel, "id">
}

/** What `deliver` writes: exactly one subject, a deal OR a form submission. */
type Delivery = {
  workspaceId: string
  userId: string
  type: NotificationType
  dealId: string | null
  taskId: string | null
  commentId: string | null
  formSubmissionId: string | null
  payload: NotificationPayload
  channels: { inApp: boolean; push: boolean }
}

export type NotifyOutcome = {
  /** The in-app row, null when the member has `inApp` off or the type off. */
  notification: NotificationModel | null
  /** True when a push job was enqueued (member has `push` on). */
  pushEnqueued: boolean
}

const NOTHING: NotifyOutcome = { notification: null, pushEnqueued: false }

/**
 * Per-user notifications (s194): one `notify` = the member's preference gate
 * AND the pipeline-access gate (a members-only pipeline never leaks a deal
 * title to a non-member, whoever assigned the task), then the in-app row
 * (`inApp`), a push job on the notification queue (`push`) and a realtime
 * `notificationCreated` to that user's open sockets. The push enqueue and
 * the realtime send each log their own failure and never throw; the row
 * insert can (the database is the one dependency that must work). Callers
 * still wrap the call so a deal write never fails on a notification bug. A
 * departed member (no row) is silently skipped, so a stale mention cannot
 * notify a stranger.
 */
export class NotificationService extends BaseService {
  async notify(input: NotifyInput): Promise<NotifyOutcome> {
    const { workspaceId, userId, type, dealId, payload } = input
    const taskId = input.taskId ?? null
    const commentId = input.commentId ?? null
    const member = await workspaceMemberService.findByWorkspaceIdAndUserId({
      workspaceId,
      userId,
    })
    if (!member) {
      logger.info({ workspaceId, userId, type }, "notification: not a member")
      return NOTHING
    }
    const prefs = resolveMemberNotificationPrefs(member)
    if (!prefs.types[type]) {
      return NOTHING
    }
    const pipeline = await pipelineService.findOrFail({
      workspaceId,
      id: payload.pipelineId,
    })
    const visible = await canViewPipeline({
      viewer: { userId, permissions: member.permissions },
      pipeline,
    })
    if (!visible) {
      logger.info(
        { workspaceId, userId, type, pipelineId: pipeline.id },
        "notification: recipient cannot view the pipeline, skipped",
      )
      return NOTHING
    }
    // s198: an assigned-only recipient sees only deals they own; a task on
    // someone else's deal must not carry its titles to them either
    const owner = viewerOwnerFilter({ userId, permissions: member.permissions })
    if (owner !== undefined) {
      const [deal] = await db
        .select({ ownerId: dealModel.ownerId })
        .from(dealModel)
        .where(
          and(eq(dealModel.id, dealId), eq(dealModel.workspaceId, workspaceId)),
        )
        .limit(1)
      if (deal?.ownerId !== owner) {
        logger.info(
          { workspaceId, userId, type, dealId },
          "notification: assigned-only recipient does not own the deal, skipped",
        )
        return NOTHING
      }
    }

    return await this.deliver({
      workspaceId,
      userId,
      type,
      dealId,
      taskId,
      commentId,
      formSubmissionId: null,
      payload,
      channels: prefs.channels,
    })
  }

  /**
   * A form's `notifyUsers` action (s220 A2-3): each named user gets one bell
   * row per submission (partial unique on (formSubmissionId, userId), so a
   * retried submit cannot notify twice) when they are still a member, keep
   * `formSubmitted` on, have Contacts access, and, if they see only assigned
   * contacts, the contact is theirs: the payload names the contact.
   */
  async notifyFormSubmission(
    input: NotifyFormSubmissionInput,
  ): Promise<NotifyOutcome[]> {
    const { workspaceId, contactId, formId, formTitle, submission } = input
    const outcomes: NotifyOutcome[] = []
    for (const userId of [...new Set(input.userIds)]) {
      const member = await workspaceMemberService.findByWorkspaceIdAndUserId({
        workspaceId,
        userId,
      })
      if (!member) {
        logger.info(
          { workspaceId, userId, formId },
          "notification: not a member",
        )
        outcomes.push(NOTHING)
        continue
      }
      const prefs = resolveMemberNotificationPrefs(member)
      // no permissions object = no access (fail closed, never a throw mid-loop)
      const permissions = member.permissions ?? {}
      if (!(prefs.types.formSubmitted && hasContactsAccess(permissions))) {
        outcomes.push(NOTHING)
        continue
      }
      // the contacts list's assigned-only rule (contact/service.ts
      // withContactAccessScope): only a contact whose conversation is theirs
      const assignedTo = assignedOnlyUserId({
        permissions,
        userId,
      })
      const contact = await db.query.contactModel.findFirst({
        where: assignedTo
          ? {
              id: contactId,
              workspaceId,
              conversation: { assignedUserId: assignedTo },
            }
          : { id: contactId, workspaceId },
        columns: { fullName: true },
      })
      if (!contact) {
        logger.info(
          { workspaceId, userId, formId },
          "notification: recipient cannot see the contact, skipped",
        )
        outcomes.push(NOTHING)
        continue
      }
      outcomes.push(
        await this.deliver({
          workspaceId,
          userId,
          type: "formSubmitted",
          dealId: null,
          taskId: null,
          commentId: null,
          formSubmissionId: submission.id,
          payload: {
            formId,
            formTitle,
            submissionId: submission.id,
            contactName: contact.fullName ?? null,
          },
          channels: prefs.channels,
        }),
      )
    }
    return outcomes
  }

  /** The in-app row, the push job and the realtime nudge, per the member's channels. */
  private async deliver(input: Delivery): Promise<NotifyOutcome> {
    const {
      workspaceId,
      userId,
      type,
      dealId,
      taskId,
      commentId,
      formSubmissionId,
      payload,
    } = input
    const prefs = { channels: input.channels }
    let notification: NotificationModel | null = null
    if (prefs.channels.inApp) {
      const [row] = await db
        .insert(notificationModel)
        .values({
          id: createId(),
          workspaceId,
          userId,
          type,
          dealId,
          taskId,
          commentId,
          formSubmissionId,
          // jsonb: written explicitly, never by a drizzle default (AGENTS.md)
          payload,
        })
        .onConflictDoNothing()
        .returning()
      if (!row) {
        // a partial unique on (commentId | formSubmissionId, userId): already notified
        return NOTHING
      }
      notification = row
    }

    let pushEnqueued = false
    if (prefs.channels.push) {
      const notificationId = notification?.id ?? null
      // Without a row the job id is derived from the event itself, so a
      // retried caller cannot enqueue the same push twice while the first
      // job is still retained.
      const jobId = notificationId
        ? `notify-user-${notificationId}`
        : `notify-user-${workspaceId}-${userId}-${type}-${taskId ?? commentId ?? formSubmissionId ?? dealId}`
      try {
        await notificationQueue.add(
          NotificationJobAction.notifyUser,
          {
            type: NotificationJobAction.notifyUser,
            data: {
              workspaceId,
              userId,
              notificationType: type,
              dealId,
              taskId,
              commentId,
              formSubmissionId,
              notificationId,
              payload,
            },
          },
          { jobId },
        )
        pushEnqueued = true
      } catch (err) {
        logger.warn(
          { err, workspaceId, userId, type },
          "notification: push enqueue failed",
        )
      }
    }

    if (notification) {
      try {
        await sendToWorkspaceMember(
          { workspaceId, userId },
          {
            eventType: RealtimeEventType.notificationCreated,
            data: {
              id: notification.id,
              type: notification.type,
              dealId: notification.dealId,
              taskId: notification.taskId,
              commentId: notification.commentId,
              formSubmissionId: notification.formSubmissionId,
              payload: notification.payload,
              createdAt: notification.createdAt.toISOString(),
            },
          },
        )
      } catch (err) {
        // the 60 s poll still shows it; only the live nudge was lost
        logger.warn(
          { err, workspaceId, userId, notificationId: notification.id },
          "notification: realtime send failed",
        )
      }
    }
    return { notification, pushEnqueued }
  }

  /**
   * Unread first, then newest. The cursor is `<rank>:<id>` of the last row
   * (rank 1 = unread WHEN IT WAS RETURNED): the anchor's createdAt is
   * re-read, its rank is not, so a row marked read between two pages keeps
   * the keyset consistent instead of hiding every remaining unread row.
   * A malformed cursor reads as the first page.
   */
  async list(props: {
    workspaceId: string
    userId: string
    cursor?: string | null
    limit?: number
    unreadOnly?: boolean
  }): Promise<{ data: NotificationModel[]; nextCursor: string | null }> {
    const { workspaceId, userId, cursor, unreadOnly } = props
    const limit = Math.min(
      Math.max(Math.trunc(props.limit ?? 20), 1),
      MAX_NOTIFICATION_PAGE,
    )
    const conditions = [
      eq(notificationModel.workspaceId, workspaceId),
      eq(notificationModel.userId, userId),
    ]
    if (unreadOnly) {
      conditions.push(isNull(notificationModel.readAt))
    }
    const parsed = cursor ? CURSOR.exec(cursor) : null
    if (parsed) {
      const [, rank, anchorId] = parsed
      const [anchor] = await db
        .select({ createdAt: notificationModel.createdAt })
        .from(notificationModel)
        .where(
          and(
            eq(notificationModel.id, anchorId),
            eq(notificationModel.userId, userId),
          ),
        )
        .limit(1)
      if (!anchor) {
        // an unknown cursor (row deleted) must not restart at page one
        return { data: [], nextCursor: null }
      }
      conditions.push(
        sql`(${unreadRankExpr()}, ${notificationModel.createdAt}, ${notificationModel.id}) < (${Number(rank)}, ${anchor.createdAt}, ${anchorId})`,
      )
    }
    const rows = await db
      .select()
      .from(notificationModel)
      .where(and(...conditions))
      .orderBy(
        desc(unreadRankExpr()),
        desc(notificationModel.createdAt),
        desc(notificationModel.id),
      )
      .limit(limit + 1)
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return {
      data: page,
      nextCursor:
        rows.length > limit && last
          ? `${last.readAt === null ? 1 : 0}:${last.id}`
          : null,
    }
  }

  async countUnread(props: {
    workspaceId: string
    userId: string
  }): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(notificationModel)
      .where(
        and(
          eq(notificationModel.workspaceId, props.workspaceId),
          eq(notificationModel.userId, props.userId),
          isNull(notificationModel.readAt),
        ),
      )
    return Number(row?.count ?? 0)
  }

  /**
   * Mark one of the viewer's notifications read (idempotent). A mention
   * notification also marks its `DealCommentMention` row so the two read
   * states never disagree.
   */
  async markRead(props: {
    workspaceId: string
    userId: string
    id: string
    tx?: DatabaseClient
  }): Promise<{ marked: boolean }> {
    const { workspaceId, userId, id, tx = db } = props
    const [row] = await tx
      .update(notificationModel)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notificationModel.id, id),
          eq(notificationModel.workspaceId, workspaceId),
          eq(notificationModel.userId, userId),
          isNull(notificationModel.readAt),
        ),
      )
      .returning({ commentId: notificationModel.commentId })
    if (!row) {
      return { marked: false }
    }
    if (row.commentId) {
      await tx
        .update(dealCommentMentionModel)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(dealCommentMentionModel.workspaceId, workspaceId),
            eq(dealCommentMentionModel.commentId, row.commentId),
            eq(dealCommentMentionModel.userId, userId),
            isNull(dealCommentMentionModel.readAt),
          ),
        )
    }
    return { marked: true }
  }

  /** The other direction: a mention marked read from the comment marks its notification. */
  async markReadByComment(props: {
    workspaceId: string
    userId: string
    commentId: string
    tx?: DatabaseClient
  }): Promise<void> {
    const { workspaceId, userId, commentId, tx = db } = props
    await tx
      .update(notificationModel)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notificationModel.workspaceId, workspaceId),
          eq(notificationModel.userId, userId),
          eq(notificationModel.commentId, commentId),
          isNull(notificationModel.readAt),
        ),
      )
  }

  async markAllRead(props: {
    workspaceId: string
    userId: string
  }): Promise<{ count: number }> {
    const { workspaceId, userId } = props
    return await db.transaction(async (tx) => {
      const rows = await tx
        .update(notificationModel)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notificationModel.workspaceId, workspaceId),
            eq(notificationModel.userId, userId),
            isNull(notificationModel.readAt),
          ),
        )
        .returning({ commentId: notificationModel.commentId })
      const commentIds = rows
        .map((r) => r.commentId)
        .filter((c): c is string => c !== null)
      if (commentIds.length > 0) {
        await tx
          .update(dealCommentMentionModel)
          .set({ readAt: new Date() })
          .where(
            and(
              eq(dealCommentMentionModel.workspaceId, workspaceId),
              eq(dealCommentMentionModel.userId, userId),
              isNull(dealCommentMentionModel.readAt),
              inArray(dealCommentMentionModel.commentId, commentIds),
            ),
          )
      }
      return { count: rows.length }
    })
  }
}

export const notificationService = new NotificationService()
