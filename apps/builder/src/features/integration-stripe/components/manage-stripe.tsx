"use client"

import type { StripeConnectionSummary } from "@chatbotx.io/business/integration-stripe"
import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { zodResolver } from "@hookform/resolvers/zod"
import { useHookFormAction } from "@next-safe-action/adapter-react-hook-form/hooks"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useState } from "react"
import { toast } from "sonner"
import { SettingRow } from "@/components/setting-row"
import { DisconnectIntegrationDialog } from "@/features/common/components/disconnect-integration-dialog"
import { AiIntegrationApiKeyDialog } from "@/features/integration-ai/components/ai-integration-api-key-dialog"
import { connectStripeAction } from "../actions/connect.action"
import { disconnectStripeAction } from "../actions/disconnect.action"
import { connectStripeSchema } from "../schema"

export function ManageStripe(props: {
  workspaceId: string
  connection: Pick<
    StripeConnectionSummary,
    "accountId" | "accountName" | "livemode" | "keyLast4"
  > | null
}) {
  const [open, setOpen] = useState(false)
  const [disconnectOpen, setDisconnectOpen] = useState(false)
  const router = useRouter()
  const t = useTranslations()
  const featureName = t("stripe.title")
  const { form, handleSubmitWithAction } = useHookFormAction(
    connectStripeAction.bind(null, props.workspaceId),
    zodResolver(connectStripeSchema),
    {
      actionProps: {
        onSuccess: () => {
          setOpen(false)
          router.refresh()
          toast.success(t("messages.connectSuccess", { feature: featureName }))
        },
        onError: ({ error }) =>
          error.serverError && toast.error(error.serverError),
      },
      formProps: { mode: "onChange", defaultValues: { apiKey: "" } },
    },
  )
  const { executeAsync: disconnect, isPending } = useAction(
    disconnectStripeAction.bind(null, props.workspaceId),
    {
      onSuccess: () => {
        setDisconnectOpen(false)
        router.refresh()
        toast.success(t("messages.disconnectSuccess", { feature: featureName }))
      },
      onError: ({ error }) =>
        error.serverError && toast.error(error.serverError),
    },
  )
  const { connection } = props

  return (
    <SettingRow
      description={
        <>
          <span>{t("stripe.setting.description")}</span>
          {connection && (
            <span className="flex flex-wrap items-center gap-2">
              <span className="truncate">
                {connection.accountName ?? connection.accountId}
              </span>
              <Badge variant={connection.livemode ? "default" : "secondary"}>
                {connection.livemode ? t("stripe.live") : t("stripe.test")}
              </Badge>
              <span>
                {t("stripe.keyEnding", { last4: connection.keyLast4 })}
              </span>
            </span>
          )}
        </>
      }
      label={t("stripe.setting.label")}
    >
      {connection ? (
        <DisconnectIntegrationDialog
          featureLabel={featureName}
          isPending={isPending}
          onConfirm={disconnect}
          onOpenChange={setDisconnectOpen}
          open={disconnectOpen}
        />
      ) : (
        <AiIntegrationApiKeyDialog
          credentialLabel={t("stripe.fields.secretKey")}
          form={form}
          onOpenChange={setOpen}
          onSubmit={handleSubmitWithAction}
          open={open}
          title={featureName}
        />
      )}
    </SettingRow>
  )
}
