import { z } from "zod"

/**
 * Per-user in-app notifications (s194). Each type maps to one member
 * preference key of the same name in `workspaceMemberNotificationTypesSchema`.
 */
export const notificationTypes = z.enum([
  "taskAssigned",
  "dealMentioned",
  // a form submission, sent by the form's notifyUsers action (s220 A2-3)
  "formSubmitted",
])
export type NotificationType = z.infer<typeof notificationTypes>

/** Closed payloads: the UI renders from them without a second query. */
export const dealNotificationPayloadSchema = z
  .object({
    /** The deal's pipeline: the bell deep-links to the board without a lookup. */
    pipelineId: z.string(),
    dealTitle: z.string().nullable(),
    taskTitle: z.string().optional(),
    actorId: z.string().nullable(),
    excerpt: z.string().optional(),
  })
  .strict()
export type DealNotificationPayload = z.infer<
  typeof dealNotificationPayloadSchema
>

/** `formSubmitted` (s220): the bell links to the form's submissions. */
export const formNotificationPayloadSchema = z
  .object({
    formId: z.string(),
    formTitle: z.string(),
    submissionId: z.string(),
    /** The contact's display name at submit time; null when it has none. */
    contactName: z.string().nullable(),
  })
  .strict()
export type FormNotificationPayload = z.infer<
  typeof formNotificationPayloadSchema
>

export const notificationPayloadSchema = z.union([
  dealNotificationPayloadSchema,
  formNotificationPayloadSchema,
])
export type NotificationPayload = z.infer<typeof notificationPayloadSchema>

export const isFormNotificationPayload = (
  payload: NotificationPayload,
): payload is FormNotificationPayload => "submissionId" in payload

export const MAX_NOTIFICATION_PAGE = 50
