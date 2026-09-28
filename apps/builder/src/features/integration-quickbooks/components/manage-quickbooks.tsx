"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Switch } from "@chatbotx.io/ui/components/ui/switch"
import { Loader2Icon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { SettingRow } from "@/components/setting-row"
import { DisconnectIntegrationDialog } from "@/features/common/components/disconnect-integration-dialog"
import { startQuickbooksConnectAction } from "../actions/connect.action"
import {
  disconnectQuickbooksAction,
  setQuickbooksMirrorAction,
} from "../actions/settings.action"

export type QuickbooksCompanyView = {
  companyName: string | null
  realmId: string
  homeCurrency: string
  environment: "sandbox" | "production"
  mirrorEnabled: boolean
  tokenRefreshError: string | null
}

export type QuickbooksConnectOutcome =
  | "connected"
  | "conflict"
  | "failed"
  | "cancelled"

const OUTCOME_KEYS = {
  connected: "quickbooks.connected",
  conflict: "quickbooks.connectConflict",
  failed: "quickbooks.connectFailed",
  cancelled: "quickbooks.connectCancelled",
} as const

export function ManageQuickbooks(props: {
  workspaceId: string
  appConfigured: boolean
  company: QuickbooksCompanyView | null
  /** The OAuth callback's closed result code (`?quickbooks=`), shown once. */
  outcome: QuickbooksConnectOutcome | null
}) {
  const t = useTranslations()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const shown = useRef(false)
  useEffect(() => {
    if (!props.outcome || shown.current) {
      return
    }
    shown.current = true
    const message = t(OUTCOME_KEYS[props.outcome])
    if (props.outcome === "connected") {
      toast.success(message)
    } else {
      toast.error(message)
    }
    router.replace(window.location.pathname)
  }, [props.outcome, router, t])
  const { company } = props
  const connect = useAction(
    startQuickbooksConnectAction.bind(null, props.workspaceId),
    {
      onSuccess: ({ data }) => {
        if (data?.url) {
          window.location.assign(data.url)
        }
      },
      onError: ({ error }) =>
        error.serverError && toast.error(error.serverError),
    },
  )
  const mirror = useAction(
    setQuickbooksMirrorAction.bind(null, props.workspaceId),
    {
      onSuccess: () => router.refresh(),
      onError: ({ error }) =>
        error.serverError && toast.error(error.serverError),
    },
  )
  const disconnect = useAction(
    disconnectQuickbooksAction.bind(null, props.workspaceId),
    {
      onSuccess: () => {
        setOpen(false)
        router.refresh()
        toast.success(
          t("messages.disconnectSuccess", { feature: t("quickbooks.title") }),
        )
      },
      onError: ({ error }) =>
        error.serverError && toast.error(error.serverError),
    },
  )

  const connectButton = (label: string) => (
    <Button
      data-testid="quickbooks-connect"
      disabled={!props.appConfigured || connect.isPending}
      onClick={() => connect.execute()}
      size="sm"
    >
      {connect.isPending && <Loader2Icon className="animate-spin" />}
      {label}
    </Button>
  )

  return (
    <div className="flex flex-col gap-4">
      <SettingRow
        description={
          <>
            <span>{t("quickbooks.setting.description")}</span>
            {!props.appConfigured && (
              <span className="text-destructive">
                {t("quickbooks.notConfigured")}
              </span>
            )}
          </>
        }
        label={t("quickbooks.setting.label")}
      >
        {company
          ? connectButton(t("quickbooks.reconnect"))
          : connectButton(t("quickbooks.connect"))}
      </SettingRow>
      {company && (
        <>
          <SettingRow
            description={
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="min-w-0 truncate">
                  {t("quickbooks.company", {
                    name: company.companyName ?? company.realmId,
                    currency: company.homeCurrency,
                  })}
                </span>
                {company.environment === "sandbox" && (
                  <span>{t("quickbooks.sandbox")}</span>
                )}
                {company.tokenRefreshError && (
                  <span className="text-destructive">
                    {t("quickbooks.reconnectNeeded", {
                      error: company.tokenRefreshError,
                    })}
                  </span>
                )}
              </span>
            }
            label={company.companyName ?? company.realmId}
          >
            <DisconnectIntegrationDialog
              featureLabel={t("quickbooks.title")}
              isPending={disconnect.isPending}
              onConfirm={disconnect.executeAsync}
              onOpenChange={setOpen}
              open={open}
            />
          </SettingRow>
          <SettingRow
            description={t("quickbooks.mirror.description")}
            label={t("quickbooks.mirror.label")}
          >
            <Switch
              checked={company.mirrorEnabled}
              data-testid="quickbooks-mirror"
              disabled={mirror.isPending}
              onCheckedChange={(enabled) => mirror.execute({ enabled })}
            />
          </SettingRow>
        </>
      )}
    </div>
  )
}
