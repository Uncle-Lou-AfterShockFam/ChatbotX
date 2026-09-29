"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@chatbotx.io/ui/components/ui/dialog"
import { Loader2Icon, LogOutIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { authClient } from "@/lib/auth/auth-client"

/**
 * The sign-out confirm dialog. Uncontrolled it renders its own trigger (the
 * account rail). Inside a dropdown menu it must be CONTROLLED and rendered
 * outside the menu: a dialog mounted in the menu is unmounted when the menu
 * closes on click, so "Sign Out" silently did nothing (s222b, reproduced on
 * netcup: no request sent, session intact after reload).
 */
export function SignOut(
  props: { open?: boolean; onOpenChange?: (open: boolean) => void } = {},
) {
  const t = useTranslations()
  const [isLoading, setIsLoading] = useState(false)
  const router = useRouter()
  const controlled = props.open !== undefined

  return (
    <Dialog
      {...(controlled
        ? { open: props.open, onOpenChange: props.onOpenChange }
        : {})}
    >
      {controlled ? null : (
        <DialogTrigger className="relative flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden transition-colors focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0">
          <LogOutIcon />
          {t("actions.signOut")}
        </DialogTrigger>
      )}
      <DialogContent className={"max-h-screen max-w-xl overflow-y-scroll"}>
        <DialogHeader>
          <DialogTitle>{t("actions.signOut")}</DialogTitle>
          <DialogDescription>
            {t("messages.signOutConfirmation")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-end gap-2">
          <DialogClose
            render={
              <Button size="sm" type="button" variant="ghost">
                {t("actions.cancel")}
              </Button>
            }
          />
          <Button
            disabled={isLoading}
            onClick={async () => {
              setIsLoading(true)

              await authClient.signOut({
                fetchOptions: {
                  onSuccess: () => {
                    router.push("/auth/sign-in")
                  },
                },
              })
            }}
            size="sm"
            variant="destructive"
          >
            {isLoading && <Loader2Icon className="animate-spin" />}
            {t("actions.signOut")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
