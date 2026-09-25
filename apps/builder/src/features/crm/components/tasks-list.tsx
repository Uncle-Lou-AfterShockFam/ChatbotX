"use client"

import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Checkbox } from "@chatbotx.io/ui/components/ui/checkbox"
import { useFormatter, useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { onActionError } from "@/features/common/lib/on-action-error"
import { completeDealTaskAction } from "@/features/deal-tasks/actions/complete-deal-task-action"
import type { DealTaskResource } from "@/features/deal-tasks/schema/resource"
import type { DealResource } from "@/features/deals/schema/resource"

/** Tasks rolled up over several deals: complete / reopen in place, the deal named per row. */
export function TasksList({
  workspaceId,
  tasks,
  deals,
  onChanged,
}: {
  workspaceId: string
  tasks: DealTaskResource[]
  deals: Pick<DealResource, "id" | "title">[]
  onChanged: () => void
}) {
  const t = useTranslations()
  const format = useFormatter()
  const toggle = useAction(completeDealTaskAction.bind(null, workspaceId), {
    onSuccess: onChanged,
    onError: onActionError,
  })
  if (tasks.length === 0) {
    return <p className="text-muted-foreground text-sm">{t("crm.noTasks")}</p>
  }
  const now = new Date()
  const dealTitle = (id: string) => deals.find((d) => d.id === id)?.title ?? ""
  return (
    <ul className="divide-y" data-testid="crm-tasks">
      {tasks.map((task) => {
        const overdue =
          task.status === "open" && task.dueAt !== null && task.dueAt < now
        return (
          <li
            className="flex items-center gap-3 py-2 text-sm"
            data-testid="crm-task-row"
            key={task.id}
          >
            <Checkbox
              aria-label={task.title}
              checked={task.status === "done"}
              disabled={toggle.isPending}
              onCheckedChange={() =>
                toggle.execute({
                  dealId: task.dealId,
                  taskId: task.id,
                  reopen: task.status === "done",
                })
              }
            />
            <div className="min-w-0 flex-1">
              <div
                className={`truncate ${task.status === "done" ? "text-muted-foreground line-through" : ""}`}
              >
                {task.title}
              </div>
              <div className="truncate text-muted-foreground text-xs">
                {t("crm.taskOf", { deal: dealTitle(task.dealId) })}
              </div>
            </div>
            {task.dueAt ? (
              <Badge variant={overdue ? "destructive" : "outline"}>
                {format.dateTime(task.dueAt, {
                  dateStyle: "medium",
                  timeZone: "UTC",
                })}
              </Badge>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
