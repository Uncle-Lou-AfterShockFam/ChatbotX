import { notificationService } from "@chatbotx.io/business/notification"
import { MAX_NOTIFICATION_PAGE } from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"
import { withWorkspaceIdSchema } from "@/features/workspaces/schema/resource"
import { workspaceAuthorizedMidddleware } from "@/middlewares/auth"
import { authorizedAPI } from "@/orpc"
import { notificationResource } from "../schema/resource"

/**
 * The viewer's OWN notifications (s194): every route scopes on
 * `context.user.id`, so a notification id from another member is a no-op
 * (`marked: false`), never a 403 that confirms it exists.
 */
const listNotificationsRequest = withWorkspaceIdSchema.and(
  z.object({
    cursor: zodBigintAsString().nullish(),
    limit: z.coerce.number().int().min(1).max(MAX_NOTIFICATION_PAGE).optional(),
    unreadOnly: z.coerce.boolean().optional(),
  }),
)

const privateListNotificationsAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/notifications",
    summary: "My notifications, unread first",
    tags: ["Notifications"],
  })
  .input(listNotificationsRequest)
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .output(
    z.object({
      data: z.array(notificationResource),
      nextCursor: z.string().nullable(),
    }),
  )
  .handler(
    async ({ input, context }) =>
      await notificationService.list({
        workspaceId: input.workspaceId,
        userId: context.user.id,
        cursor: input.cursor ?? null,
        limit: input.limit,
        unreadOnly: input.unreadOnly,
      }),
  )

const privateCountUnreadNotificationsAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/notifications/unread-count",
    summary: "How many of my notifications are unread",
    tags: ["Notifications"],
  })
  .input(withWorkspaceIdSchema)
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .output(z.object({ count: z.number().int() }))
  .handler(async ({ input, context }) => ({
    count: await notificationService.countUnread({
      workspaceId: input.workspaceId,
      userId: context.user.id,
    }),
  }))

const privateMarkNotificationReadAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/notifications/{id}/read",
    summary: "Mark one of my notifications read",
    tags: ["Notifications"],
  })
  .input(withWorkspaceIdSchema.and(z.object({ id: zodBigintAsString() })))
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .output(z.object({ marked: z.boolean() }))
  .handler(
    async ({ input, context }) =>
      await notificationService.markRead({
        workspaceId: input.workspaceId,
        userId: context.user.id,
        id: input.id,
      }),
  )

const privateMarkAllNotificationsReadAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/notifications/read-all",
    summary: "Mark every one of my notifications read",
    tags: ["Notifications"],
  })
  .input(withWorkspaceIdSchema)
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .output(z.object({ count: z.number().int() }))
  .handler(
    async ({ input, context }) =>
      await notificationService.markAllRead({
        workspaceId: input.workspaceId,
        userId: context.user.id,
      }),
  )

export const privateNotificationsAPI = {
  privateListNotificationsAPI,
  privateCountUnreadNotificationsAPI,
  privateMarkNotificationReadAPI,
  privateMarkAllNotificationsReadAPI,
}
