import type {
  ContentType,
  FormNotificationPayload,
  NotificationPayload,
} from "@chatbotx.io/database/partials"
import type { NotificationJobData } from "@chatbotx.io/worker-config"
import { t } from "./strings"

const resolveIncomingMessageBody = (
  strings: ReturnType<typeof t>,
  data: {
    messageText?: string
    contentType?: ContentType
    attachmentCount?: number
  },
): string => {
  if (data.messageText) {
    return data.messageText
  }
  if (data.contentType === "location") {
    return strings.sharedLocation
  }
  if (data.contentType === "refLink") {
    return strings.sentLink
  }
  if (data.attachmentCount === 1) {
    return strings.sentAttachment
  }
  if (data.attachmentCount && data.attachmentCount > 1) {
    return strings.sentAttachments(data.attachmentCount)
  }
  return ""
}

/**
 * A form-submission payload (s220). Local and type-only on purpose: a value
 * import of the partials here loads the id generator into the push worker's
 * module graph (a second Snowflake in tests that reset modules).
 */
export const isFormPayload = (
  payload: NotificationPayload,
): payload is FormNotificationPayload => "submissionId" in payload

export const buildNotificationContent = (props: {
  job: NotificationJobData
  contactFullName: string | null | undefined
  workspaceLanguage: string | undefined
}): { title: string; body: string } => {
  const { job, contactFullName, workspaceLanguage } = props
  const strings = t(workspaceLanguage)

  if (job.type === "notifyUser") {
    const { notificationType, payload } = job.data
    if (isFormPayload(payload)) {
      // s220: "<form title>" / "<contact> submitted it" (or the generic line)
      return {
        title: payload.formTitle || strings.formSubmitted,
        body: payload.contactName ?? strings.formSubmitted,
      }
    }
    if (notificationType === "taskAssigned") {
      return {
        title: payload.taskTitle || payload.dealTitle || strings.assignedTask,
        body: strings.assignedTask,
      }
    }
    return {
      title: payload.dealTitle || strings.mentionedInDeal,
      body: payload.excerpt || strings.mentionedInDeal,
    }
  }

  if (job.type === "notifyConversationAssigned") {
    return {
      title: contactFullName ?? strings.newMessage,
      body: strings.assignedConversation,
    }
  }

  return {
    title: contactFullName ?? strings.newMessage,
    body: resolveIncomingMessageBody(strings, job.data),
  }
}
