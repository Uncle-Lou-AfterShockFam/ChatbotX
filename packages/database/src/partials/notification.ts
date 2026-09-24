import { z } from "zod"

/**
 * Per-user in-app notifications (s194). Each type maps to one member
 * preference key of the same name in `workspaceMemberNotificationTypesSchema`.
 */
export const notificationTypes = z.enum(["taskAssigned", "dealMentioned"])
export type NotificationType = z.infer<typeof notificationTypes>

/** Closed payload: the UI renders from it without a second query. */
export const notificationPayloadSchema = z
  .object({
    /** The deal's pipeline: the bell deep-links to the board without a lookup. */
    pipelineId: z.string(),
    dealTitle: z.string().nullable(),
    taskTitle: z.string().optional(),
    actorId: z.string().nullable(),
    excerpt: z.string().optional(),
  })
  .strict()
export type NotificationPayload = z.infer<typeof notificationPayloadSchema>

export const MAX_NOTIFICATION_PAGE = 50
