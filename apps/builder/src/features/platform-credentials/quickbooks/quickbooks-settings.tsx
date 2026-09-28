"use client"

import {
  type QuickbooksCredentialPublic,
  type QuickbooksCredentialUpdate,
  quickbooksCredentialUpdateSchema,
} from "@chatbotx.io/database/partials"
import { InputField } from "@chatbotx.io/ui/components/form/input-field"
import { SelectField } from "@chatbotx.io/ui/components/form/select-field"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@chatbotx.io/ui/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@chatbotx.io/ui/components/ui/dialog"
import { Form } from "@chatbotx.io/ui/components/ui/form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useHookFormAction } from "@next-safe-action/adapter-react-hook-form/hooks"
import { BookOpenCheckIcon, CopyIcon, Loader2Icon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useState } from "react"
import { toast } from "sonner"
import { useClipboard } from "@/hooks/use-clipboard"
import { CredentialFallbackNote } from "../credential-fallback-note"
import { DeleteCredentialDialog } from "../delete-credential-dialog"
import { useCredentialScope } from "../provider/credential-scope-context"
import { deleteQuickbooksSettingsAction } from "./delete-quickbooks-settings.action"
import { updateQuickbooksSettingsAction } from "./update-quickbooks-settings.action"

function CopyRow(props: { label: string; value: string }) {
  const { handleCopy } = useClipboard()
  return (
    <div className="flex flex-col gap-2">
      <div className="font-bold">{props.label}:</div>
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate">{props.value}</span>
        <Button
          className="flex-none"
          onClick={() => handleCopy(props.value)}
          size="icon"
          type="button"
          variant="outline"
        >
          <CopyIcon className="size-4" />
        </Button>
      </div>
    </div>
  )
}

/**
 * The platform's Intuit app (s214b): workspaces connect their own QuickBooks
 * company through it. Intuit takes ONE redirect URL and ONE webhook URL.
 */
export function QuickbooksSettings({
  publicConfig,
  isInherited = false,
  callbackOrigin,
}: {
  publicConfig: QuickbooksCredentialPublic | null
  isInherited?: boolean
  callbackOrigin: string
}) {
  const t = useTranslations()
  return (
    <Card>
      <CardHeader className="items-center justify-center">
        <CardTitle className="flex items-center gap-2">
          <BookOpenCheckIcon className="size-6" />
          <span>{t("quickbooksCredential.title")}</span>
        </CardTitle>
        <CardAction>
          <EditQuickbooksSettingsDialog publicConfig={publicConfig} />
        </CardAction>
      </CardHeader>
      <CardContent>
        {publicConfig?.clientId ? (
          <div className="flex flex-col gap-4">
            <CopyRow label="Client ID" value={publicConfig.clientId} />
            <div>
              <span className="font-bold">
                {t("quickbooksCredential.environment")}:
              </span>{" "}
              {publicConfig.environment}
            </div>
            <CopyRow
              label={t("fields.authCallbackUrl.label")}
              value={`${callbackOrigin}/integrations/quickbooks/callback`}
            />
            <CopyRow
              label={t("quickbooksCredential.webhookUrl")}
              value={`${callbackOrigin}/integrations/quickbooks/webhook`}
            />
            <p className="text-muted-foreground text-sm">
              {t("quickbooksCredential.hint")}
            </p>
          </div>
        ) : (
          <CredentialFallbackNote isInherited={isInherited} />
        )}
      </CardContent>
    </Card>
  )
}

function EditQuickbooksSettingsDialog({
  publicConfig,
}: {
  publicConfig: QuickbooksCredentialPublic | null
}) {
  const t = useTranslations()
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const close = () => {
    setOpen(false)
    router.refresh()
  }
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={
          <Button size="sm" type="button">
            {t("actions.edit")}
          </Button>
        }
      />
      <DialogContent>
        <DialogTitle>
          {t("messages.editFeature", { feature: "QuickBooks" })}
        </DialogTitle>
        <QuickbooksEditSettingsForm
          onClose={close}
          publicConfig={publicConfig}
        />
      </DialogContent>
    </Dialog>
  )
}

function QuickbooksEditSettingsForm({
  publicConfig,
  onClose,
}: {
  publicConfig: QuickbooksCredentialPublic | null
  onClose: () => void
}) {
  const t = useTranslations()
  const scope = useCredentialScope()
  const { execute: executeDelete, isPending: isDeleting } = useAction(
    deleteQuickbooksSettingsAction.bind(null, scope),
    {
      onSuccess: () => {
        toast.success(t("messages.deletedSuccess", { feature: "QuickBooks" }))
        onClose()
      },
      onError: ({ error }) =>
        error.serverError && toast.error(error.serverError),
    },
  )
  const { form, handleSubmitWithAction, resetFormAndAction } =
    useHookFormAction(
      updateQuickbooksSettingsAction.bind(null, scope),
      zodResolver(quickbooksCredentialUpdateSchema),
      {
        actionProps: {
          onSuccess: onClose,
          onError: ({ error }) =>
            error.serverError && toast.error(error.serverError),
        },
        formProps: {
          mode: "onChange",
          defaultValues: {
            clientId: publicConfig?.clientId ?? "",
            clientSecret: "",
            webhookVerifierToken: "",
            environment: publicConfig?.environment ?? "sandbox",
          } satisfies QuickbooksCredentialUpdate,
        },
      },
    )
  return (
    <Form {...form}>
      <form className="flex flex-col gap-4" onSubmit={handleSubmitWithAction}>
        <InputField
          label={t("fields.clientId.label")}
          name="clientId"
          required
        />
        <InputField
          label={t("fields.clientSecret.label")}
          name="clientSecret"
          required
          type="password"
        />
        <InputField
          label={t("quickbooksCredential.webhookVerifierToken")}
          name="webhookVerifierToken"
          required
          type="password"
        />
        <SelectField
          label={t("quickbooksCredential.environment")}
          name="environment"
          options={[
            { value: "sandbox", label: "Sandbox" },
            { value: "production", label: "Production" },
          ]}
          required
        />
        <div className="flex items-center justify-between gap-2">
          {publicConfig !== null && (
            <DeleteCredentialDialog
              disabled={form.formState.isSubmitting}
              feature="QuickBooks"
              isDeleting={isDeleting}
              onConfirm={() => executeDelete()}
            />
          )}
          <div className="ms-auto flex gap-2">
            <Button
              onClick={() => {
                resetFormAndAction()
                onClose()
              }}
              type="button"
              variant="outline"
            >
              {t("actions.cancel")}
            </Button>
            <Button
              disabled={
                !form.formState.isValid ||
                form.formState.isSubmitting ||
                isDeleting
              }
              type="submit"
            >
              {form.formState.isSubmitting && (
                <Loader2Icon className="size-4 animate-spin" />
              )}
              {t("actions.save")}
            </Button>
          </div>
        </div>
      </form>
    </Form>
  )
}
