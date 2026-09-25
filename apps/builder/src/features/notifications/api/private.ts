import { workspaceMemberService } from "@chatbotx.io/business"
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
    /** `<rank>:<id>` from the previous page's `nextCursor` */
    cursor: z.string().max(40).nullish(),
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

/** The caller's self-service preferences (s198); closed on every level. */
const ownNotificationPrefsResource = z.object({
  types: z.object({ taskAssigned: z.boolean(), dealMentioned: z.boolean() }),
  channels: z.object({ inApp: z.boolean(), push: z.boolean() }),
})
export const updateOwnNotificationPrefsRequest = z
  .object({
    workspaceId: zodBigintAsString(),
    types: z
      .object({
        taskAssigned: z.boolean().optional(),
        dealMentioned: z.boolean().optional(),
      })
      .strict()
      .optional(),
    channels: z
      .object({ inApp: z.boolean().optional(), push: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict()

const privateGetNotificationPrefsAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/notifications/preferences",
    summary: "My notification preferences",
    tags: ["Notifications"],
  })
  .input(withWorkspaceIdSchema)
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .output(ownNotificationPrefsResource)
  .handler(
    async ({ input, context }) =>
      await workspaceMemberService.getOwnNotificationPrefs({
        workspaceId: input.workspaceId,
        userId: context.user.id,
      }),
  )

const privateUpdateNotificationPrefsAPI = authorizedAPI
  .route({
    method: "PATCH",
    path: "/workspaces/{workspaceId}/notifications/preferences",
    summary: "Change my notification preferences",
    tags: ["Notifications"],
  })
  .input(updateOwnNotificationPrefsRequest)
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .output(ownNotificationPrefsResource)
  .handler(
    async ({ input, context }) =>
      await workspaceMemberService.updateOwnNotificationPrefs({
        workspaceId: input.workspaceId,
        userId: context.user.id,
        // only the groups that were sent (an absent group is not a change)
        patch: {
          ...(input.types ? { types: input.types } : {}),
          ...(input.channels ? { channels: input.channels } : {}),
        },
      }),
  )

export const privateNotificationsAPI = {
  privateGetNotificationPrefsAPI,
  privateUpdateNotificationPrefsAPI,
  privateListNotificationsAPI,
  privateCountUnreadNotificationsAPI,
  privateMarkNotificationReadAPI,
  privateMarkAllNotificationsReadAPI,
}
