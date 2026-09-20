"use client"

import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { useTranslations } from "next-intl"
import type { ApiResource } from "../schema/resource"
import { ApiDisconnect } from "./api-disconnect"
import { ApiSettingsForm } from "./api-settings-form"
import { RotateTokenButton } from "./rotate-token-button"

export function ApiCredentialsCard({ api }: { api: ApiResource }) {
  const t = useTranslations()

  return (
    <div className="flex flex-col gap-3 rounded-md border p-4">
      <div className="flex items-center justify-between">
        <span className="font-medium">{api.name}</span>
        <Badge variant={api.enabled ? "default" : "secondary"}>
          {api.enabled
            ? t("fields.api.status.enabled")
            : t("fields.api.status.disabled")}
        </Badge>
      </div>

      <div className="flex flex-col gap-1 text-muted-foreground text-sm">
        <span>
          {t("fields.api.token")}: <code>{api.tokenPrefix}••••••••</code>
        </span>
        <span>
          {t("fields.api.callbackUrl.label")}:{" "}
          {api.callbackUrl ?? t("fields.api.callbackUrl.notSet")}
        </span>
        <span>
          {t("fields.api.deliveryMode.label")}:{" "}
          {t(`fields.api.deliveryMode.${api.deliveryMode}`)}
        </span>
      </div>

      <div className="flex justify-end gap-2">
        <ApiSettingsForm api={api} />
        <RotateTokenButton id={api.id} />
        <ApiDisconnect api={api} />
      </div>
    </div>
  )
}
