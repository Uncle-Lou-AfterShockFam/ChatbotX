import { sql } from "drizzle-orm"
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import {
  type NotificationPayload,
  type NotificationType,
  notificationTypes,
} from "../partials/notification"
import {
  bigintAsString,
  sharedColumns,
  timestampConfig,
} from "../partials/shared"
import { userModel } from "./auth-user"
import { dealModel } from "./deal"
import { dealCommentModel } from "./deal-comment"
import { dealTaskModel } from "./deal-task"
import { workspaceModel } from "./workspace"

export const notificationType = pgEnum(
  "notificationType",
  notificationTypes.options as [NotificationType, ...NotificationType[]],
)

/**
 * One in-app notification for one user (s194). Written by
 * `notificationService.notify` when the member's `inApp` channel is on;
 * `payload` is written explicitly (never a drizzle default) so the bell
 * renders without a second query. A mention notification is unique per
 * `(commentId, userId)` (a comment edit retried by the caller cannot notify
 * twice); task assignments deliberately repeat (A -> B -> A is two events).
 */
export const notificationModel = pgTable(
  "Notification",
  {
    ...sharedColumns,
    type: notificationType().notNull(),
    payload: jsonb().$type<NotificationPayload>().notNull(),
    readAt: timestamp(timestampConfig),
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    userId: bigintAsString()
      .notNull()
      .references(() => userModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    dealId: bigintAsString()
      .notNull()
      .references(() => dealModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    taskId: bigintAsString().references(() => dealTaskModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    commentId: bigintAsString().references(() => dealCommentModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
  },
  (table) => [
    index("Notification_userId_workspaceId_readAt_createdAt_idx").on(
      table.userId,
      table.workspaceId,
      table.readAt,
      table.createdAt,
    ),
    index("Notification_dealId_idx").on(table.dealId),
    uniqueIndex("Notification_commentId_userId_key")
      .on(table.commentId, table.userId)
      .where(sql`"commentId" IS NOT NULL`),
  ],
)
