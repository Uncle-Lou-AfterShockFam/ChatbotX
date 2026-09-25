"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@chatbotx.io/ui/components/ui/dialog"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import { Label } from "@chatbotx.io/ui/components/ui/label"
import { Loader2Icon, PlusIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { toast } from "sonner"
import { useCreateForm } from "../provider/form-hooks"

export function CreateFormDialog({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState("")
  const create = useCreateForm()
  const valid = title.trim().length > 0 && title.trim().length <= 120

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={
          <Button data-testid="create-form" size="sm">
            <PlusIcon className="size-4" />
            {t("actions.add")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("forms.addNew")}</DialogTitle>
          <DialogDescription>{t("forms.createDescription")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (!valid) {
              return
            }
            create.mutate(
              { workspaceId, title: title.trim() },
              {
                onSuccess: (form) => {
                  toast.success(
                    t("messages.createdSuccess", {
                      feature: t("forms.singular"),
                    }),
                  )
                  setOpen(false)
                  setTitle("")
                  router.push(`/space/${workspaceId}/forms/${form.id}/edit`)
                },
                onError: (error) => toast.error(error.message),
              },
            )
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-form-title">
              {t("forms.columns.title")}
            </Label>
            <Input
              autoFocus
              data-testid="create-form-title"
              id="create-form-title"
              onChange={(e) => setTitle(e.target.value)}
              value={title}
            />
          </div>
          <DialogFooter>
            <Button
              onClick={() => setOpen(false)}
              type="button"
              variant="ghost"
            >
              {t("actions.cancel")}
            </Button>
            <Button disabled={!valid || create.isPending} type="submit">
              {create.isPending ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : null}
              {t("actions.continue")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
