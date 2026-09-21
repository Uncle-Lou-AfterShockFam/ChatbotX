"use client"

import { InputField } from "@chatbotx.io/ui/components/form/input-field"
import { SelectField } from "@chatbotx.io/ui/components/form/select-field"
import { SwitchField } from "@chatbotx.io/ui/components/form/switch-field"
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
import { Loader2Icon, SettingsIcon } from "lucide-react"
import { useParams, useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { toast } from "sonner"
import { updateApiAction } from "../actions/update-api.action"
import { updateApiRequest } from "../schema/mutation"
import type { ApiResource } from "../schema/resource"

/**
 * Edit an API channel's delivery settings: name, callback URL and delivery
 * mode (push = we POST to the callback; pull = the worker leases from the
 * outbox, for a worker with no public URL).
 */
export function ApiSettingsForm({ api }: { api: ApiResource }) {
  const t = useTranslations()
  const router = useRouter()
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const [open, setOpen] = useState(false)

  const { form, handleSubmitWithAction } = useHookFormAction(
    updateApiAction.bind(null, workspaceId, api.id),
    zodResolver(updateApiRequest),
    {
      actionProps: {
        onSuccess: () => {
          setOpen(false)
          toast.success(
            t("messages.updatedSuccess", { feature: t("fields.api.label") }),
          )
          router.refresh()
        },
        onError: ({ error }) => {
          if (error.serverError) {
            toast.error(error.serverError)
          }
        },
      },
      formProps: {
        mode: "onChange",
        defaultValues: {
          name: api.name,
          callbackUrl: api.callbackUrl ?? "",
          deliveryMode: api.deliveryMode,
          shortenLinks: api.shortenLinks,
        },
      },
    },
  )

  const deliveryModeOptions = [
    { value: "push", label: t("fields.api.deliveryMode.push") },
    { value: "pull", label: t("fields.api.deliveryMode.pull") },
  ]

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline">
            <SettingsIcon className="h-4 w-4" />
            {t("actions.edit")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{api.name}</DialogTitle>
          <DialogDescription>
            {t("fields.api.deliveryMode.description")}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="flex flex-col gap-4"
            onSubmit={handleSubmitWithAction}
          >
            <InputField label={t("fields.name.label")} name="name" required />
            <InputField
              description={t("fields.api.callbackUrl.description")}
              label={t("fields.api.callbackUrl.label")}
              name="callbackUrl"
              placeholder="https://example.com/webhooks/chatbotx"
            />
            <SelectField
              label={t("fields.api.deliveryMode.label")}
              name="deliveryMode"
              options={deliveryModeOptions}
              required
            />
            <SwitchField
              description={t("fields.api.shortenLinks.description")}
              label={t("fields.api.shortenLinks.label")}
              name="shortenLinks"
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
                {t("actions.save")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
