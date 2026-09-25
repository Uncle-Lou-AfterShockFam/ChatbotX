"use client"

import { Label } from "@chatbotx.io/ui/components/ui/label"
import { Switch } from "@chatbotx.io/ui/components/ui/switch"
import { Loader2Icon } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  useOwnNotificationPrefs,
  useUpdateOwnNotificationPrefs,
} from "../provider/notification-hook"

const ROWS = [
  { group: "types", key: "taskAssigned" },
  { group: "types", key: "dealMentioned" },
  { group: "channels", key: "inApp" },
  { group: "channels", key: "push" },
] as const

/**
 * A member's own notification preferences (s198): which deal events notify
 * them and where. Each switch saves on its own; the legacy workspace
 * notification settings stay admin-only (Settings > Admins).
 */
export function NotificationPreferences({
  workspaceId,
}: {
  workspaceId: string
}) {
  const t = useTranslations()
  const prefs = useOwnNotificationPrefs(workspaceId)
  const update = useUpdateOwnNotificationPrefs()

  return (
    <div
      className="flex max-w-xl flex-col gap-4 p-4"
      data-testid="notification-preferences"
    >
      <div className="flex items-center gap-2">
        <h1 className="me-auto font-semibold text-lg">
          {t("notifications.preferences.title")}
        </h1>
        {prefs.isFetching || update.isPending ? (
          <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
        ) : null}
      </div>
      <p className="text-muted-foreground text-sm">
        {t("notifications.preferences.description")}
      </p>
      {prefs.isError ? (
        <p
          className="text-destructive text-sm"
          data-testid="notification-preferences-error"
          role="alert"
        >
          {t("notifications.preferences.loadError")}
        </p>
      ) : null}
      {ROWS.map(({ group, key }, index) => {
        const id = `notification-pref-${key}`
        const startsGroup = ROWS[index - 1]?.group !== group
        return (
          <div className="flex flex-col gap-4" key={key}>
            {startsGroup ? (
              <h2 className="font-medium text-sm">
                {t(`notifications.preferences.${group}`)}
              </h2>
            ) : null}
            <div className="flex items-start justify-between gap-4 rounded-md border px-3 py-2">
              <div className="flex flex-col gap-0.5">
                <Label htmlFor={id}>
                  {t(`notifications.preferences.${key}.label`)}
                </Label>
                <span className="text-muted-foreground text-xs">
                  {t(`notifications.preferences.${key}.hint`)}
                </span>
              </div>
              <Switch
                checked={
                  (
                    prefs.data?.[group] as Record<string, boolean> | undefined
                  )?.[key] ?? false
                }
                data-testid={id}
                disabled={!prefs.data || update.isPending}
                id={id}
                onCheckedChange={(value) =>
                  update.mutate(
                    { workspaceId, [group]: { [key]: value } },
                    { onError: (error) => toast.error(error.message) },
                  )
                }
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
