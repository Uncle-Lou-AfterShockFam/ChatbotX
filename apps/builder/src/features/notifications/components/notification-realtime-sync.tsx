"use client"

import { useMemo } from "react"
import type { RealtimeHandlerMap } from "@/features/realtime/types"
import { useWorkspaceRealtimeEvents } from "@/features/realtime/use-workspace-realtime-events"
import { useInvalidateNotifications } from "../provider/notification-hook"

/**
 * Lives INSIDE `WorkspaceRealtimeShell` (the sidebar, where the bell sits, is
 * outside the realtime provider): a `notificationCreated` for this member
 * invalidates the bell's queries through the shared QueryClient.
 */
export function NotificationRealtimeSync() {
  const invalidate = useInvalidateNotifications()
  const handlers = useMemo<RealtimeHandlerMap>(
    () => ({ notificationCreated: () => invalidate() }),
    [invalidate],
  )
  useWorkspaceRealtimeEvents(handlers)
  return null
}
