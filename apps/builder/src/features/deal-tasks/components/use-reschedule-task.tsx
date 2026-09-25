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
import { openSuccessors, type TimelineTask } from "../lib/timeline-layout"

type Dates = { startAt?: Date | null; dueAt?: Date | null }
type Pending = { taskId: string; dates: Dates; successors: number }

/**
 * Save a task's new dates. When the due date moves and open tasks wait on
 * this one, ask first: "also shift them" (`shiftSuccessors`) or "only this
 * task" (the timeline then shows the conflict). Shared by the list and the
 * timeline so both ask the same question.
 */
export function useRescheduleTask(props: {
  workspaceId: string
  dealId: string
  tasks: Pick<TimelineTask, "id" | "status" | "dependsOn" | "dueAt">[]
  onSaved: () => void
}): {
  reschedule: (taskId: string, dates: Dates) => void
  isPending: boolean
  dialog: ReactNode
} {
  const { workspaceId, dealId, tasks, onSaved } = props
  const t = useTranslations()
  const [pending, setPending] = useState<Pending | null>(null)
  const update = useAction(updateDealTaskAction.bind(null, workspaceId), {
    onSuccess: onSaved,
    onError: onActionError,
  })
  const save = (taskId: string, dates: Dates, shiftSuccessors: boolean) => {
    update.execute({ dealId, taskId, ...dates, shiftSuccessors })
    setPending(null)
  }
  const reschedule = (taskId: string, dates: Dates) => {
    const task = tasks.find((x) => x.id === taskId)
    const dueMoved =
      dates.dueAt !== undefined &&
      task?.dueAt &&
      dates.dueAt &&
      new Date(task.dueAt).getTime() !== dates.dueAt.getTime()
    const successors = dueMoved ? openSuccessors(tasks, taskId).length : 0
    if (successors === 0) {
      save(taskId, dates, false)
      return
    }
    setPending({ taskId, dates, successors })
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
            {t("deals.tasks.shiftTitle", { count: pending?.successors ?? 0 })}
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
              pending && save(pending.taskId, pending.dates, false)
            }
            variant="outline"
          >
            {t("deals.tasks.shiftOnlyThis")}
          </Button>
          <Button
            data-testid="task-shift-all"
            onClick={() => pending && save(pending.taskId, pending.dates, true)}
          >
            {t("deals.tasks.shiftAll")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
  return { reschedule, isPending: update.isPending, dialog }
}
