import {
  notificationPayloadSchema,
  notificationTypes,
} from "@chatbotx.io/database/partials"
import {
  createSelectSchema,
  notificationModel,
} from "@chatbotx.io/database/schema"
import z from "zod"

export const notificationResource = createSelectSchema(notificationModel, {
  id: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  dealId: z.string(),
  taskId: z.string().nullable(),
  commentId: z.string().nullable(),
  type: notificationTypes,
  payload: notificationPayloadSchema,
})
export type NotificationResource = z.infer<typeof notificationResource>
