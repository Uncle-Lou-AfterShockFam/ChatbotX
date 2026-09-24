import type {
  ContentType,
  NotificationPayload,
  NotificationType,
} from "@chatbotx.io/database/partials"
import { Queue } from "bullmq"
import {
  defaultJobOptions,
  fakeQueue,
  getRedisConnection,
  isNoRedisEnv,
} from "../../lib/connection"
import { queueNames } from "../../lib/types"

export const NotificationJobAction = {
  notifyIncomingMessage: "notifyIncomingMessage",
  notifyConversationAssigned: "notifyConversationAssigned",
  notifyUser: "notifyUser",
} as const

export type NotificationJobNotifyIncomingMessage = {
  type: typeof NotificationJobAction.notifyIncomingMessage
  data: {
    workspaceId: string
    conversationId: string
    messageId: string
    /** Preview text built at enqueue time — Message is a hypertable whose
     *  lookup needs createdAt, which this payload deliberately does not carry. */
    messageText?: string
    contentType?: ContentType
    attachmentCount?: number
    /** Recipient to skip, e.g. the agent whose own outbound reply round-tripped
     *  back as an "incoming" message via a channel's echo/coexist sync. Optional
     *  because most channels have no way to identify the sending user. */
    excludeUserId?: string
  }
}

export type NotificationJobNotifyConversationAssigned = {
  type: typeof NotificationJobAction.notifyConversationAssigned
  data: {
    workspaceId: string
    conversationId: string
    assignedUserId: string
  }
}

/**
 * A per-USER push (s194): task assignment / deal mention. Keyed by userId,
 * never a conversation; `notificationId` is the in-app row (null when the
 * member turned `inApp` off but kept `push`). `workspaceId` stays first-class
 * because the worker's blocked-owner guard reads it.
 */
export type NotificationJobNotifyUser = {
  type: typeof NotificationJobAction.notifyUser
  data: {
    workspaceId: string
    userId: string
    notificationType: NotificationType
    dealId: string
    taskId: string | null
    commentId: string | null
    notificationId: string | null
    payload: NotificationPayload
  }
}

export type NotificationJobData =
  | NotificationJobNotifyIncomingMessage
  | NotificationJobNotifyConversationAssigned
  | NotificationJobNotifyUser

export const notificationQueue = isNoRedisEnv()
  ? fakeQueue
  : new Queue<NotificationJobData>(queueNames.enum.notification, {
      connection: getRedisConnection(),
      defaultJobOptions,
    })
