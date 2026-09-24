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
  MAX_NOTIFICATION_PAGE,
  type NotificationPayload,
  type NotificationType,
} from "@chatbotx.io/database/partials"
import {
  dealCommentMentionModel,
  notificationModel,
} from "@chatbotx.io/database/schema"
import type { NotificationModel } from "@chatbotx.io/database/types"
import { RealtimeEventType } from "@chatbotx.io/partysocket-config"
import { createId } from "@chatbotx.io/utils"
import {
  NotificationJobAction,
  notificationQueue,
} from "@chatbotx.io/worker-config"
import { BaseService } from "../base.service"
import { logger } from "../logger"
import { canViewPipeline } from "../pipeline/access"
import { pipelineService } from "../pipeline/service"
import { sendToWorkspaceMember } from "../platform/realtime-broadcast"
import { resolveMemberNotificationPrefs } from "../workspace-member/notification-prefs"
import { workspaceMemberService } from "../workspace-member/service"

/** Unread rows sort first; the rank rides in the cursor so a mark-read between pages cannot flip it. */
const unreadRankExpr = sql<number>`case when ${notificationModel.readAt} is null then 1 else 0 end`
const CURSOR = /^([01]):(\d{1,30})$/

export type NotifyInput = {
  workspaceId: string
  userId: string
  type: NotificationType
  dealId: string
  taskId?: string | null
  commentId?: string | null
  payload: NotificationPayload
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
          // jsonb: written explicitly, never by a drizzle default (AGENTS.md)
          payload,
        })
        .onConflictDoNothing()
        .returning()
      if (!row) {
        // the partial unique on (commentId, userId): already notified
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
        : `notify-user-${workspaceId}-${userId}-${type}-${taskId ?? commentId ?? dealId}`
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
        sql`(${unreadRankExpr}, ${notificationModel.createdAt}, ${notificationModel.id}) < (${Number(rank)}, ${anchor.createdAt}, ${anchorId})`,
      )
    }
    const rows = await db
      .select()
      .from(notificationModel)
      .where(and(...conditions))
      .orderBy(
        desc(
          sql`case when ${notificationModel.readAt} is null then 1 else 0 end`,
        ),
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
