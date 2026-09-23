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
  DialogTrigger,
} from "@chatbotx.io/ui/components/ui/dialog"
import { Loader, Trash } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import type { ComponentPropsWithoutRef } from "react"
import { toast } from "sonner"
import { deleteCompanyAction } from "./actions/delete-company-action"

type DeleteCompaniesDialogProps = ComponentPropsWithoutRef<typeof Dialog> & {
  workspaceId: string
  companies: Pick<CompanyModel, "id" | "name">[]
  showTrigger?: boolean
  onSuccess?: () => void
  onOpenChange?: (val: boolean) => void
}

export function DeleteCompaniesDialog({
  workspaceId,
  companies,
  showTrigger = true,
  onSuccess,
  onOpenChange,
  ...props
}: DeleteCompaniesDialogProps) {
  const t = useTranslations()
  const router = useRouter()

  const { execute, isPending } = useAction(
    deleteCompanyAction.bind(null, workspaceId),
    {
      onSuccess: () => {
        toast.success(
          t("messages.deletedSuccess", { feature: t("companies.one") }),
        )
        onSuccess?.()
        onOpenChange?.(false)
        router.refresh()
      },
      onError: ({ error }) => {
        if (error.serverError) {
          toast.error(error.serverError)
        }
      },
    },
  )

  return (
    <Dialog {...props}>
      {showTrigger ? (
        <DialogTrigger
          render={
            <Button size="sm" variant="outline">
              <Trash aria-hidden="true" className="me-2 size-4" />
              {t("actions.delete")} ({companies.length})
            </Button>
          }
        />
      ) : null}
      <DialogContent className="max-h-screen max-w-xl overflow-y-scroll">
        <DialogHeader>
          <DialogTitle>
            {t("messages.deleteFeature", { feature: t("companies.one") })}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-wrap text-sm/6">
            {t("companies.deleteConfirm")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:space-x-0">
          <DialogClose
            render={
              <Button size="sm" variant="ghost">
                {t("actions.cancel")}
              </Button>
            }
          />
          <Button
            disabled={isPending}
            onClick={() => execute({ ids: companies.map((c) => c.id) })}
            size="sm"
            variant="destructive"
          >
            {isPending && (
              <Loader aria-hidden="true" className="me-2 size-4 animate-spin" />
            )}
            {t("actions.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
