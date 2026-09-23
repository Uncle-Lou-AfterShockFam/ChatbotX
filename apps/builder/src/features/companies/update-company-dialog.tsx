"use client"

import type { CompanyModel } from "@chatbotx.io/database/types"
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
import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2Icon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useEffect } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import z from "zod"
import { updateCompanyAction } from "./actions/update-company-action"
import { CompanyFormFields, splitDomains } from "./company-form-fields"
import { updateCompanyRequest } from "./schema/action"

const formSchema = updateCompanyRequest
  .omit({ domains: true })
  .extend({ id: z.string(), domainsText: z.string().optional() })
type FormValues = z.infer<typeof formSchema>

export function UpdateCompanyDialog({
  workspaceId,
  company,
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (val: boolean) => void
  workspaceId: string
  company: CompanyModel | null
}) {
  const t = useTranslations()
  const router = useRouter()

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    mode: "onChange",
  })
  const { execute, isPending } = useAction(
    updateCompanyAction.bind(null, workspaceId),
    {
      onSuccess: () => {
        toast.success(
          t("messages.updatedSuccess", { feature: t("companies.one") }),
        )
        onOpenChange(false)
        router.refresh()
      },
      onError: ({ error }) => {
        if (error.serverError) {
          toast.error(error.serverError)
        }
      },
    },
  )
  const handleSubmitWithAction = form.handleSubmit(
    ({ domainsText, ...values }) =>
      execute({ ...values, domains: splitDomains(domainsText) }),
  )

  const { reset } = form
  useEffect(() => {
    if (company) {
      reset({
        id: company.id,
        name: company.name,
        domainsText: company.domains.join(", "),
        website: company.website ?? "",
        phone: company.phone ?? "",
        notes: company.notes ?? "",
        stopOnReply: company.stopOnReply,
      })
    }
  }, [company, reset])

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-screen max-w-xl overflow-y-scroll">
        <DialogHeader>
          <DialogTitle>
            {t("messages.editFeature", { feature: t("companies.one") })}
          </DialogTitle>
          <DialogDescription />
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-6" onSubmit={handleSubmitWithAction}>
            <CompanyFormFields />
            <DialogFooter>
              <DialogClose
                render={
                  <Button size="sm" type="button" variant="ghost">
                    {t("actions.cancel")}
                  </Button>
                }
              />
              <Button disabled={isPending} size="sm" type="submit">
                {isPending && <Loader2Icon className="animate-spin" />}
                {t("actions.confirm")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
