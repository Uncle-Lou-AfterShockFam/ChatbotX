"use client"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@chatbotx.io/ui/components/ui/alert-dialog"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { useTranslations } from "next-intl"
import type { ComponentProps, ReactNode } from "react"

/** A button that asks before it acts (replaces window.confirm, which blocks the browser). */
export function ConfirmButton({
  title,
  description,
  onConfirm,
  children,
  ...buttonProps
}: ComponentProps<typeof Button> & {
  title: string
  description: string
  onConfirm: () => void
  children: ReactNode
}) {
  const t = useTranslations()
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={<Button {...buttonProps}>{children}</Button>}
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
          <AlertDialogAction data-testid="confirm-action" onClick={onConfirm}>
            {t("actions.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
