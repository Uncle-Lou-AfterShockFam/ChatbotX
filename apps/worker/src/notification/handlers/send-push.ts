import {
  contactService,
  conversationService,
  workspaceMemberService,
  workspaceService,
} from "@chatbotx.io/business"
import type { ConversationModel } from "@chatbotx.io/database/types"
import type {
  NotificationJobData,
  NotificationJobNotifyUser,
} from "@chatbotx.io/worker-config"
import type { Expo } from "expo-server-sdk"
import { logger } from "../../lib/logger"
import { buildNotificationContent } from "../lib/build-notification-content"
import { deliverPushToUsers } from "../lib/deliver-push"
import { getExpoClient } from "../lib/expo"

type ConversationJob = Exclude<NotificationJobData, NotificationJobNotifyUser>

/**
 * Recipients = the assigned user, else every workspace member (unassigned
 * conversations fan out — noisy for large workspaces but acceptable for v1;
 * presence-aware suppression is a post-MVP concern).
 */
const resolveRecipientUserIds = async (
  job: ConversationJob,
  conversation: ConversationModel,
): Promise<string[]> => {
  if (job.type === "notifyConversationAssigned") {
    return [job.data.assignedUserId]
  }

  const excludeUserId = job.data.excludeUserId
  const recipientUserIds = conversation.assignedUserId
    ? [conversation.assignedUserId]
    : await workspaceMemberService.listUserIdsByWorkspaceId({
        workspaceId: job.data.workspaceId,
      })

  return excludeUserId
    ? recipientUserIds.filter((userId) => userId !== excludeUserId)
    : recipientUserIds
}

const resolveNotificationContent = async (
  job: ConversationJob,
  conversation: ConversationModel,
): Promise<{ title: string; body: string }> => {
  const { workspaceId } = job.data

  const [contact, workspace] = await Promise.all([
    contactService.findById({
      workspaceId,
      id: conversation.contactId,
    }),
    workspaceService.find({ where: { id: workspaceId } }),
  ])

  return buildNotificationContent({
    job,
    contactFullName: contact?.fullName,
    workspaceLanguage: workspace?.language,
  })
}

/**
 * A per-user job (s194): no conversation, the ONE recipient is in the
 * payload. `data` is the deep link: the builder opens
 * `/space/{workspaceId}/deals?dealId=...`.
 */
const sendUserPush = async (
  expo: Expo,
  job: NotificationJobNotifyUser,
): Promise<void> => {
  const { workspaceId, userId, notificationType, dealId, taskId, commentId } =
    job.data
  const workspace = await workspaceService.find({ where: { id: workspaceId } })
  const { title, body } = buildNotificationContent({
    job,
    contactFullName: undefined,
    workspaceLanguage: workspace?.language,
  })
  const { sent } = await deliverPushToUsers({
    expo,
    userIds: [userId],
    title,
    body,
    data: {
      workspaceId,
      kind: notificationType,
      dealId,
      taskId,
      commentId,
      notificationId: job.data.notificationId,
    },
  })
  logger.info(
    { workspaceId, userId, notificationType, sent },
    "user push notification processed",
  )
}

export const sendPushForNotificationJob = async (
  job: NotificationJobData,
): Promise<void> => {
  const expo = getExpoClient()
  if (!expo) {
    return
  }

  if (job.type === "notifyUser") {
    await sendUserPush(expo, job)
    return
  }

  const conversation = await conversationService.findByOrFail({
    where: { id: job.data.conversationId, workspaceId: job.data.workspaceId },
  })

  const recipientUserIds = await resolveRecipientUserIds(job, conversation)
  if (recipientUserIds.length === 0) {
    return
  }

  const { workspaceId, conversationId } = job.data
  const messageId = "messageId" in job.data ? job.data.messageId : ""
  const { title, body } = await resolveNotificationContent(job, conversation)

  await deliverPushToUsers({
    expo,
    userIds: recipientUserIds,
    title,
    body,
    data: { workspaceId, conversationId, messageId },
  })
}
