import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"
import { orpc } from "@/lib/orpc/query"

/**
 * The bell's data (s194). Realtime `notificationCreated` invalidates these
 * keys from `NotificationRealtimeSync`; the 60 s refetch is the fallback
 * for a workspace without realtime.
 */
export const NOTIFICATION_POLL_MS = 60_000

export const useNotifications = (workspaceId: string, enabled = true) =>
  useQuery(
    orpc.notificationsAPI.privateListNotificationsAPI.queryOptions({
      input: { workspaceId, limit: 20 },
      enabled,
      refetchInterval: NOTIFICATION_POLL_MS,
    }),
  )

export const useUnreadNotificationCount = (workspaceId: string) =>
  useQuery(
    orpc.notificationsAPI.privateCountUnreadNotificationsAPI.queryOptions({
      input: { workspaceId },
      refetchInterval: NOTIFICATION_POLL_MS,
      select: (res) => res.count,
    }),
  )

export const useInvalidateNotifications = () => {
  const queryClient = useQueryClient()
  return useCallback(
    () =>
      queryClient.invalidateQueries({ queryKey: orpc.notificationsAPI.key() }),
    [queryClient],
  )
}

export const useMarkNotificationRead = () => {
  const invalidate = useInvalidateNotifications()
  return useMutation(
    orpc.notificationsAPI.privateMarkNotificationReadAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

export const useMarkAllNotificationsRead = () => {
  const invalidate = useInvalidateNotifications()
  return useMutation(
    orpc.notificationsAPI.privateMarkAllNotificationsReadAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

/** The caller's self-service notification preferences (s198). */
export const useOwnNotificationPrefs = (workspaceId: string) =>
  useQuery(
    orpc.notificationsAPI.privateGetNotificationPrefsAPI.queryOptions({
      input: { workspaceId },
    }),
  )

export const useUpdateOwnNotificationPrefs = () => {
  const invalidate = useInvalidateNotifications()
  return useMutation(
    orpc.notificationsAPI.privateUpdateNotificationPrefsAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}
