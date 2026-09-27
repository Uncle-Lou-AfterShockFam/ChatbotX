"use client"

import { InputField } from "@chatbotx.io/ui/components/form/input-field"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@chatbotx.io/ui/components/ui/dialog"
import { Form } from "@chatbotx.io/ui/components/ui/form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useHookFormAction } from "@next-safe-action/adapter-react-hook-form/hooks"
import { CopyIcon, Loader2Icon, PlusIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useState } from "react"
import { toast } from "sonner"
import { SettingRow } from "@/components/setting-row"
import { useClipboard } from "@/hooks/use-clipboard"
import { DisconnectIntegrationDialog } from "@/features/common/components/disconnect-integration-dialog"
import { connectWooCommerceAction } from "../actions/connect.action"
import { disconnectWooCommerceAction } from "../actions/disconnect.action"
import { connectWooCommerceSchema } from "../schema"

type Site = {
  integrationId: string
  siteSlug: string
  siteUrl: string
  tokenLast4: string
  currency: string
}

/** The two wp-config lines, shown once after a connect. */
type WpConfig = { siteSlug: string; hubUrl: string; hubSecret: string }

const wpConfigLines = (config: WpConfig) =>
  [
    `define( 'HUBC_HUB_URL', '${config.hubUrl}' );`,
    `define( 'HUBC_HUB_SECRET', '${config.hubSecret}' );`,
  ].join("\n")

export function ManageWooCommerce(props: {
  workspaceId: string
  sites: Site[]
}) {
  const t = useTranslations()
  const [wpConfig, setWpConfig] = useState<WpConfig | null>(null)

  return (
    <div className="flex flex-col gap-4">
      <SettingRow
        description={t("woocommerce.setting.description")}
        label={t("woocommerce.setting.label")}
      >
        <ConnectSiteDialog
          onConnected={setWpConfig}
          workspaceId={props.workspaceId}
        />
      </SettingRow>
      {props.sites.length === 0 ? (
        <div className="text-muted-foreground text-sm">
          {t("woocommerce.empty")}
        </div>
      ) : (
        props.sites.map((site) => (
          <SiteRow key={site.integrationId} site={site} {...props} />
        ))
      )}
      <WpConfigDialog config={wpConfig} onClose={() => setWpConfig(null)} />
    </div>
  )
}

function SiteRow(props: { workspaceId: string; site: Site }) {
  const { site } = props
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const t = useTranslations()
  const { executeAsync, isPending } = useAction(
    disconnectWooCommerceAction.bind(
      null,
      props.workspaceId,
      site.integrationId,
    ),
    {
      onSuccess: () => {
        setOpen(false)
        router.refresh()
        toast.success(
          t("messages.disconnectSuccess", { feature: site.siteSlug }),
        )
      },
      onError: ({ error }) =>
        error.serverError && toast.error(error.serverError),
    },
  )
  return (
    <SettingRow
      description={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate">{site.siteUrl}</span>
          <span>{site.currency}</span>
          <span>
            {t("woocommerce.tokenEnding", { last4: site.tokenLast4 })}
          </span>
        </span>
      }
      label={site.siteSlug}
    >
      <DisconnectIntegrationDialog
        featureLabel={`${t("woocommerce.title")}: ${site.siteSlug}`}
        isPending={isPending}
        onConfirm={executeAsync}
        onOpenChange={setOpen}
        open={open}
      />
    </SettingRow>
  )
}

function ConnectSiteDialog(props: {
  workspaceId: string
  onConnected: (config: WpConfig) => void
}) {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const t = useTranslations()
  const { form, handleSubmitWithAction } = useHookFormAction(
    connectWooCommerceAction.bind(null, props.workspaceId),
    zodResolver(connectWooCommerceSchema),
    {
      actionProps: {
        onSuccess: ({ data }) => {
          setOpen(false)
          form.reset()
          router.refresh()
          toast.success(
            t("messages.connectSuccess", { feature: t("woocommerce.title") }),
          )
          if (data) {
            props.onConnected(data)
          }
        },
        onError: ({ error }) =>
          error.serverError && toast.error(error.serverError),
      },
      formProps: {
        mode: "onChange",
        defaultValues: {
          siteSlug: "",
          siteUrl: "",
          actionToken: "",
        },
      },
    },
  )
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={
          <Button data-testid="woocommerce-connect" size="sm">
            <PlusIcon />
            {t("woocommerce.addSite")}
          </Button>
        }
      />
      <DialogContent className="max-h-screen overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("woocommerce.addSite")}</DialogTitle>
          <DialogDescription>{t("woocommerce.addSiteHelp")}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-4" onSubmit={handleSubmitWithAction}>
            <InputField
              label={t("woocommerce.fields.siteUrl")}
              name="siteUrl"
              placeholder="https://shop.example.org"
              required
            />
            <InputField
              label={t("woocommerce.fields.siteSlug")}
              name="siteSlug"
              placeholder="my-shop"
              required
            />
            <InputField
              label={t("woocommerce.fields.actionToken")}
              name="actionToken"
              required
              type="password"
            />
            <DialogFooter>
              <DialogClose
                render={
                  <Button type="button" variant="secondary">
                    {t("actions.cancel")}
                  </Button>
                }
              />
              <Button
                disabled={
                  !form.formState.isValid || form.formState.isSubmitting
                }
                type="submit"
              >
                {form.formState.isSubmitting && (
                  <Loader2Icon className="animate-spin" />
                )}
                {t("actions.confirm")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

function WpConfigDialog(props: {
  config: WpConfig | null
  onClose: () => void
}) {
  const t = useTranslations()
  const { config } = props
  const { handleCopy } = useClipboard()
  const copy = () => config && handleCopy(wpConfigLines(config))
  return (
    <Dialog
      onOpenChange={(next) => !next && props.onClose()}
      open={config !== null}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("woocommerce.wpConfig.title", { site: config?.siteSlug ?? "" })}
          </DialogTitle>
          <DialogDescription>
            {t("woocommerce.wpConfig.description")}
          </DialogDescription>
        </DialogHeader>
        {config && (
          <pre
            className="overflow-x-auto whitespace-pre rounded-md bg-muted p-3 text-xs"
            data-testid="woocommerce-wp-config"
          >
            {wpConfigLines(config)}
          </pre>
        )}
        <DialogFooter>
          <Button onClick={copy} type="button" variant="secondary">
            <CopyIcon />
            {t("woocommerce.wpConfig.copy")}
          </Button>
          <DialogClose
            render={<Button type="button">{t("actions.ok")}</Button>}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
