"use client"

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
import { Loader2Icon, PlusIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useCallback, useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import z from "zod"
import { createCompanyAction } from "./actions/create-company-action"
import { CompanyFormFields, splitDomains } from "./company-form-fields"
import { createCompanyRequest } from "./schema/action"

const formSchema = createCompanyRequest
  .omit({ domains: true })
  .extend({ domainsText: z.string().optional() })
type FormValues = z.infer<typeof formSchema>

const DEFAULT_VALUES: FormValues = {
  name: "",
  domainsText: "",
  website: "",
  phone: "",
  notes: "",
  stopOnReply: true,
}

export function CreateCompanyDialog({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations()
  const router = useRouter()
  const [open, setOpen] = useState(false)

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    mode: "onChange",
    defaultValues: DEFAULT_VALUES,
  })
  const {
    execute,
    isPending,
    reset: resetAction,
  } = useAction(createCompanyAction.bind(null, workspaceId), {
    onSuccess: () => {
      toast.success(
        t("messages.createdSuccess", { feature: t("companies.one") }),
      )
      setOpen(false)
      form.reset(DEFAULT_VALUES)
      router.refresh()
    },
    onError: ({ error }) => {
      if (error.serverError) {
        toast.error(error.serverError)
      }
    },
  })
  const resetFormAndAction = useCallback(() => {
    form.reset(DEFAULT_VALUES)
    resetAction()
  }, [form, resetAction])
  const handleSubmitWithAction = form.handleSubmit(
    ({ domainsText, ...values }) =>
      execute({ ...values, domains: splitDomains(domainsText) }),
  )

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      setOpen(isOpen)
      if (!isOpen) {
        resetFormAndAction()
      }
    },
    [resetFormAndAction],
  )

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogTrigger
        render={
          <Button size="sm">
            <PlusIcon />
            {t("messages.createFeature", { feature: t("companies.one") })}
          </Button>
        }
      />
      <DialogContent className="max-h-screen max-w-xl overflow-y-scroll">
        <DialogHeader>
          <DialogTitle>
            {t("messages.createFeature", { feature: t("companies.one") })}
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
              <Button
                disabled={!form.formState.isValid || isPending}
                size="sm"
                type="submit"
              >
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
