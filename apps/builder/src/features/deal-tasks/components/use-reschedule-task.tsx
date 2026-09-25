"use client"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@chatbotx.io/ui/components/ui/alert-dialog"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { type ReactNode, useState } from "react"
import { onActionError } from "@/features/common/lib/on-action-error"
import { updateDealTaskAction } from "../actions/update-deal-task-action"

type Dates = { startAt?: Date | null; dueAt?: Date | null }
/** The task being moved: its deal, stored due date and open successor count. */
export type RescheduleTarget = {
  dealId: string
  taskId: string
  dueAt: Date | string | null
  openSuccessors: number
}
type Pending = { target: RescheduleTarget; dates: Dates }

/**
 * Save a task's new dates. When the due date moves and open tasks wait on
 * this one, ask first: "also shift them" (`shiftSuccessors`) or "only this
 * task" (the timeline then shows the conflict). Shared by the drawer list,
 * the timeline and the workspace calendar so all ask the same question.
 */
export function useRescheduleTask(props: {
  workspaceId: string
  onSaved: () => void
}): {
  reschedule: (target: RescheduleTarget, dates: Dates) => void
  isPending: boolean
  dialog: ReactNode
} {
  const { workspaceId, onSaved } = props
  const t = useTranslations()
  const [pending, setPending] = useState<Pending | null>(null)
  const update = useAction(updateDealTaskAction.bind(null, workspaceId), {
    onSuccess: onSaved,
    onError: onActionError,
  })
  const save = (
    target: RescheduleTarget,
    dates: Dates,
    shiftSuccessors: boolean,
  ) => {
    update.execute({
      dealId: target.dealId,
      taskId: target.taskId,
      ...dates,
      shiftSuccessors,
    })
    setPending(null)
  }
  const reschedule = (target: RescheduleTarget, dates: Dates) => {
    // a CLEARED due date has no delta to shift successors by: no question
    const dueMoved =
      dates.dueAt !== undefined &&
      target.dueAt &&
      dates.dueAt &&
      new Date(target.dueAt).getTime() !== dates.dueAt.getTime()
    if (!dueMoved || target.openSuccessors === 0) {
      save(target, dates, false)
      return
    }
    setPending({ target, dates })
  }
  const dialog = (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) {
          setPending(null)
        }
      }}
      open={pending !== null}
    >
      <AlertDialogContent data-testid="task-shift-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("deals.tasks.shiftTitle", {
              count: pending?.target.openSuccessors ?? 0,
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("deals.tasks.shiftHint")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="task-shift-cancel">
            {t("actions.cancel")}
          </AlertDialogCancel>
          <Button
            data-testid="task-shift-only"
            onClick={() =>
              pending && save(pending.target, pending.dates, false)
            }
            variant="outline"
          >
            {t("deals.tasks.shiftOnlyThis")}
          </Button>
          <Button
            data-testid="task-shift-all"
            onClick={() => pending && save(pending.target, pending.dates, true)}
          >
            {t("deals.tasks.shiftAll")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
  return { reschedule, isPending: update.isPending, dialog }
}
