"use client"

import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@chatbotx.io/ui/components/ui/popover"
import { ScrollArea } from "@chatbotx.io/ui/components/ui/scroll-area"
import { cn } from "@chatbotx.io/ui/lib/utils"
import { AtSignIcon, BellIcon, ClipboardCheckIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useFormatter, useTranslations } from "next-intl"
import { useState } from "react"
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useUnreadNotificationCount,
} from "../provider/notification-hook"
import type { NotificationResource } from "../schema/resource"

const BADGE_CAP = 99

/**
 * Where a notification opens: the deal board on its pipeline with the drawer
 * open. `status=all` because the drawer finds the deal in the loaded columns
 * and a comment on a won / lost deal is normal (blind probe, s194).
 */
export const notificationHref = (
  workspaceId: string,
  n: Pick<NotificationResource, "dealId" | "payload">,
) =>
  `/space/${workspaceId}/deals?pipelineId=${encodeURIComponent(
    n.payload.pipelineId,
  )}&status=all&dealId=${encodeURIComponent(n.dealId)}`

export const badgeLabel = (count: number) =>
  count > BADGE_CAP ? `${BADGE_CAP}+` : String(count)

/**
 * Sidebar bell (s194): unread badge, the latest 20 notifications (unread
 * first), mark one / all read. A click marks the row read and opens the deal.
 */
export function NotificationBell({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations()
  const format = useFormatter()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const unread = useUnreadNotificationCount(workspaceId)
  const list = useNotifications(workspaceId, open)
  const markRead = useMarkNotificationRead()
  const markAll = useMarkAllNotificationsRead()
  const count = unread.data ?? 0
  const rows = list.data?.data ?? []

  const openNotification = (n: NotificationResource) => {
    if (!n.readAt) {
      markRead.mutate({ workspaceId, id: n.id })
    }
    setOpen(false)
    router.push(notificationHref(workspaceId, n))
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button
            aria-label={t("notifications.title")}
            className="relative"
            data-testid="notification-bell"
            size="icon"
            variant="ghost"
          />
        }
      >
        <BellIcon />
        {count > 0 ? (
          <Badge
            className="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px]"
            data-testid="notification-badge"
            variant="destructive"
          >
            {badgeLabel(count)}
          </Badge>
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="font-medium text-sm">
            {t("notifications.title")}
          </span>
          <Button
            disabled={count === 0 || markAll.isPending}
            onClick={() => markAll.mutate({ workspaceId })}
            size="sm"
            variant="ghost"
          >
            {t("notifications.markAllRead")}
          </Button>
        </div>
        <ScrollArea className="max-h-96">
          {rows.length === 0 ? (
            <p className="p-4 text-muted-foreground text-sm">
              {list.isPending ? t("common.loading") : t("notifications.empty")}
            </p>
          ) : (
            <ul className="divide-y" data-testid="notification-list">
              {rows.map((n) => (
                <li key={n.id}>
                  <button
                    className={cn(
                      "flex w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-accent",
                      !n.readAt && "bg-accent/40",
                    )}
                    data-testid="notification-row"
                    data-unread={n.readAt ? undefined : "true"}
                    onClick={() => openNotification(n)}
                    type="button"
                  >
                    {n.type === "taskAssigned" ? (
                      <ClipboardCheckIcon className="mt-0.5 size-4 shrink-0" />
                    ) : (
                      <AtSignIcon className="mt-0.5 size-4 shrink-0" />
                    )}
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate font-medium">
                        {n.type === "taskAssigned"
                          ? t("notifications.taskAssigned", {
                              task: n.payload.taskTitle ?? "",
                            })
                          : t("notifications.dealMentioned")}
                      </span>
                      <span className="truncate text-muted-foreground">
                        {n.payload.dealTitle ?? ""}
                        {n.payload.excerpt ? ` — ${n.payload.excerpt}` : ""}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {format.relativeTime(new Date(n.createdAt))}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
