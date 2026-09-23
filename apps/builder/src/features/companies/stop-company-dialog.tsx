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
import { Loader, OctagonXIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import type { ComponentPropsWithoutRef } from "react"
import { toast } from "sonner"
import { stopCompanyAction } from "./actions/stop-company-action"

type StopCompanyDialogProps = ComponentPropsWithoutRef<typeof Dialog> & {
  workspaceId: string
  company: Pick<CompanyModel, "id" | "name" | "stoppedAt"> | null
  showTrigger?: boolean
  onOpenChange?: (val: boolean) => void
}

export function StopCompanyDialog({
  workspaceId,
  company,
  showTrigger = true,
  onOpenChange,
  ...props
}: StopCompanyDialogProps) {
  const t = useTranslations()
  const router = useRouter()
  const alreadyStopped = Boolean(company?.stoppedAt)

  const { execute, isPending } = useAction(
    stopCompanyAction.bind(null, workspaceId),
    {
      onSuccess: ({ data }) => {
        if (data?.status === "stopped") {
          toast.success(
            t("companies.stoppedToast", {
              name: company?.name ?? "",
              count: data.contactCount,
            }),
          )
        } else if (data?.status === "already_stopped") {
          toast.info(t("companies.alreadyStopped"))
        } else if (data?.status === "skipped") {
          toast.info(t("companies.stopSkipped"))
        }
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
              <OctagonXIcon aria-hidden="true" className="me-2 size-4" />
              {alreadyStopped ? t("companies.rerunStop") : t("companies.stop")}
            </Button>
          }
        />
      ) : null}
      <DialogContent className="max-h-screen max-w-xl overflow-y-scroll">
        <DialogHeader>
          <DialogTitle>
            {t("companies.stopTitle", { name: company?.name ?? "" })}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-wrap text-sm/6">
            {alreadyStopped
              ? t("companies.rerunStopConfirm")
              : t("companies.stopConfirm")}
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
            disabled={isPending || !company}
            onClick={() =>
              company && execute({ id: company.id, force: alreadyStopped })
            }
            size="sm"
            variant="destructive"
          >
            {isPending && (
              <Loader aria-hidden="true" className="me-2 size-4 animate-spin" />
            )}
            {alreadyStopped ? t("companies.rerunStop") : t("companies.stop")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
