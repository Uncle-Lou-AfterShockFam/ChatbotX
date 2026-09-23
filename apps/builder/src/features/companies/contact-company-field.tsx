"use client"

import { ComboboxField } from "@chatbotx.io/ui/components/form/combobox-field"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@chatbotx.io/ui/components/ui/dialog"
import { Form } from "@chatbotx.io/ui/components/ui/form"
import { Building2Icon, Loader2Icon } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useEffect, useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { setContactCompanyAction } from "./actions/set-contact-company-action"
import {
  useCompanySelectOptions,
  useInvalidateCompanies,
} from "./provider/company-hook"

/**
 * The contact drawer's company row: the linked company (a link to its page)
 * and a picker dialog that assigns or clears it.
 */
export function ContactCompanyField({
  workspaceId,
  contactId,
  company,
}: {
  workspaceId: string
  contactId: string
  company: { id: string; name: string; stoppedAt: Date | null } | null
}) {
  const t = useTranslations()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const form = useForm<{ companyId: string }>({
    defaultValues: { companyId: company?.id ?? "" },
  })

  const options = useCompanySelectOptions({ enabled: open })
  const invalidateCompanies = useInvalidateCompanies()
  const { execute: save, isPending: saving } = useAction(
    setContactCompanyAction.bind(null, workspaceId),
    {
      onSuccess: () => {
        toast.success(
          t("messages.updatedSuccess", { feature: t("companies.one") }),
        )
        setOpen(false)
        invalidateCompanies()
        router.refresh()
      },
      onError: ({ error }) => {
        if (error.serverError) {
          toast.error(error.serverError)
        }
      },
    },
  )

  useEffect(() => {
    if (open) {
      form.reset({ companyId: company?.id ?? "" })
    }
  }, [open, company?.id, form])

  return (
    <div className="flex items-center gap-2 py-1 text-xs">
      <Building2Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="w-24 shrink-0 text-muted-foreground">
        {t("companies.one")}
      </span>
      {company ? (
        <Link
          className="flex-1 truncate hover:underline"
          href={`/space/${workspaceId}/companies/${company.id}`}
        >
          {company.name}
          {company.stoppedAt ? ` (${t("companies.stopped")})` : ""}
        </Link>
      ) : (
        <span className="flex-1 truncate text-muted-foreground">
          {t("companies.noCompany")}
        </span>
      )}
      <Button onClick={() => setOpen(true)} size="sm" variant="ghost">
        {t("actions.edit")}
      </Button>

      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("companies.assign")}</DialogTitle>
            <DialogDescription />
          </DialogHeader>
          <Form {...form}>
            <form
              className="space-y-6"
              onSubmit={form.handleSubmit((values) =>
                save({
                  contactId,
                  companyId: values.companyId ? values.companyId : null,
                }),
              )}
            >
              <ComboboxField
                allowClear
                clearLabel={t("companies.noCompany")}
                emptyText={t("companies.empty")}
                label={t("companies.one")}
                name="companyId"
                options={options.map((option) => ({
                  label: option.stopped
                    ? `${option.label} (${t("companies.stopped")})`
                    : option.label,
                  value: option.value,
                }))}
                portal
              />
              <DialogFooter>
                <DialogClose
                  render={
                    <Button size="sm" type="button" variant="ghost">
                      {t("actions.cancel")}
                    </Button>
                  }
                />
                <Button disabled={saving} size="sm" type="submit">
                  {saving && <Loader2Icon className="animate-spin" />}
                  {t("actions.confirm")}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
