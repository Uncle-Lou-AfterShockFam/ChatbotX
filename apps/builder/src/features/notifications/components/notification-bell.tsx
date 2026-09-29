"use client"

import { isFormNotificationPayload } from "@chatbotx.io/database/partials"
import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@chatbotx.io/ui/components/ui/popover"
import { cn } from "@chatbotx.io/ui/lib/utils"
import {
  AtSignIcon,
  BellIcon,
  ClipboardCheckIcon,
  FileTextIcon,
  SettingsIcon,
} from "lucide-react"
import Link from "next/link"
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
 * and a comment on a won / lost deal is normal (blind probe, s194). A form
 * submission (s220) opens that form's submissions.
 */
export const notificationHref = (
  workspaceId: string,
  n: Pick<NotificationResource, "dealId" | "payload">,
) => {
  if (isFormNotificationPayload(n.payload)) {
    return `/space/${workspaceId}/forms/${encodeURIComponent(
      n.payload.formId,
    )}/submissions`
  }
  return `/space/${workspaceId}/deals?pipelineId=${encodeURIComponent(
    n.payload.pipelineId,
  )}&status=all&dealId=${encodeURIComponent(n.dealId ?? "")}`
}

/** The row's title and second line, per type. */
const rowText = (
  t: ReturnType<typeof useTranslations>,
  n: Pick<NotificationResource, "type" | "payload">,
): { title: string; detail: string } => {
  const p = n.payload
  if (isFormNotificationPayload(p)) {
    return {
      title: t("notifications.formSubmitted"),
      detail: p.contactName ? `${p.formTitle} — ${p.contactName}` : p.formTitle,
    }
  }
  return {
    title:
      n.type === "taskAssigned"
        ? t("notifications.taskAssigned", { task: p.taskTitle ?? "" })
        : t("notifications.dealMentioned"),
    detail: `${p.dealTitle ?? ""}${p.excerpt ? ` — ${p.excerpt}` : ""}`,
  }
}

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
  // next-intl logs ENVIRONMENT_FALLBACK (a console error per row) when
  // relativeTime has no explicit `now`
  const now = new Date()
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
      {/* 16 px from every viewport edge (Base UI's default is 5), never wider
          than the screen, and never taller than the room below the bell: the
          list scrolls inside the panel instead of painting over the page. */}
      <PopoverContent
        align="start"
        className="max-h-[min(32rem,var(--available-height))] w-[min(24rem,calc(100vw-2rem))] gap-0 p-0"
        collisionPadding={16}
        data-testid="notification-panel"
      >
        <div className="flex shrink-0 items-center gap-1 border-b py-2 pr-2 pl-4">
          <span className="min-w-0 flex-1 truncate font-medium text-sm">
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
          <Button
            aria-label={t("notifications.preferences.title")}
            data-testid="notification-preferences-link"
            nativeButton={false}
            onClick={() => setOpen(false)}
            render={
              <Link href={`/space/${workspaceId}/notifications/preferences`} />
            }
            size="icon"
            title={t("notifications.preferences.title")}
            variant="ghost"
          >
            <SettingsIcon className="size-4" />
          </Button>
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          data-testid="notification-scroll"
        >
          {rows.length === 0 ? (
            <p className="px-4 py-6 text-muted-foreground text-sm">
              {list.isPending
                ? t("notifications.loading")
                : t("notifications.empty")}
            </p>
          ) : (
            <ul className="divide-y" data-testid="notification-list">
              {rows.map((n) => (
                <li key={n.id}>
                  <button
                    className={cn(
                      "flex w-full items-start gap-3 px-4 py-3 text-left text-sm hover:bg-accent",
                      !n.readAt && "bg-accent/40",
                    )}
                    data-testid="notification-row"
                    data-unread={n.readAt ? undefined : "true"}
                    onClick={() => openNotification(n)}
                    type="button"
                  >
                    {n.type === "taskAssigned" && (
                      <ClipboardCheckIcon className="mt-0.5 size-4 shrink-0" />
                    )}
                    {n.type === "dealMentioned" && (
                      <AtSignIcon className="mt-0.5 size-4 shrink-0" />
                    )}
                    {n.type === "formSubmitted" && (
                      <FileTextIcon className="mt-0.5 size-4 shrink-0" />
                    )}
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="truncate font-medium">
                        {rowText(t, n).title}
                      </span>
                      <span className="truncate text-muted-foreground">
                        {rowText(t, n).detail}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {format.relativeTime(new Date(n.createdAt), now)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
