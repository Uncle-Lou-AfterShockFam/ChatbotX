"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Checkbox } from "@chatbotx.io/ui/components/ui/checkbox"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@chatbotx.io/ui/components/ui/toggle-group"
import { cn } from "@chatbotx.io/ui/lib/utils"
import { Loader2Icon } from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useMemo, useState } from "react"
import { onActionError } from "@/features/common/lib/on-action-error"
import { CrmDealDrawer } from "@/features/crm/components/crm-deal-drawer"
import { completeDealTaskAction } from "../actions/complete-deal-task-action"
import { groupMyTasks } from "../lib/my-tasks-groups"
import { chipTone } from "../lib/task-calendar-grid"
import { localToday } from "../lib/timeline-layout"
import { useMyTasks } from "../provider/deal-task-hook"
import type { DealTaskCalendarResource } from "../schema/resource"

/**
 * Every task assigned to the caller, any date, across the deals they may
 * see (s198). Open tasks are grouped Overdue / Today / This week / Later /
 * No due date; done tasks list the latest completed first. Tick to complete
 * or reopen; click a task to open its deal.
 */
export function MyTasks({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations()
  const format = useFormatter()
  const today = localToday()
  const [status, setStatus] = useState<"open" | "done">("open")
  const [openDealId, setOpenDealId] = useState<string | null>(null)
  const tasks = useMyTasks(workspaceId, status)
  const rows = useMemo(
    () => tasks.data?.pages.flatMap((page) => page.data) ?? [],
    [tasks.data],
  )
  const groups = useMemo(() => {
    if (status === "open") {
      return groupMyTasks(rows, today)
    }
    return rows.length > 0 ? [{ key: "done" as const, rows }] : []
  }, [rows, status, today])
  const toggle = useAction(completeDealTaskAction.bind(null, workspaceId), {
    onSuccess: () => tasks.refetch(),
    onError: onActionError,
  })

  return (
    <div className="flex flex-col gap-4 p-4" data-testid="my-tasks">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="me-auto font-semibold text-lg">
          {t("tasks.mine.title")}
        </h1>
        {tasks.isFetching || toggle.isPending ? (
          <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
        ) : null}
        <ToggleGroup
          aria-label={t("tasks.mine.status")}
          onValueChange={(value) => {
            const next = value[0]
            if (next === "open" || next === "done") {
              setStatus(next)
            }
          }}
          size="sm"
          value={[status]}
          variant="outline"
        >
          <ToggleGroupItem data-testid="my-tasks-open" value="open">
            {t("tasks.mine.open")}
          </ToggleGroupItem>
          <ToggleGroupItem data-testid="my-tasks-done" value="done">
            {t("tasks.mine.done")}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {groups.map((group) => (
        <section
          aria-labelledby={`my-tasks-${group.key}-heading`}
          className="flex flex-col gap-1"
          data-testid={`my-tasks-group-${group.key}`}
          key={group.key}
        >
          <h2
            className={cn(
              "font-medium text-muted-foreground text-sm",
              group.key === "overdue" && "text-destructive",
            )}
            id={`my-tasks-${group.key}-heading`}
          >
            {t(`tasks.mine.groups.${group.key}`)} ({group.rows.length})
          </h2>
          <ul className="divide-y rounded-md border">
            {group.rows.map((task) => (
              <MyTaskRow
                busy={toggle.isPending}
                dueLabel={
                  task.dueAt
                    ? format.dateTime(new Date(task.dueAt), {
                        dateStyle: "medium",
                        timeZone: "UTC",
                      })
                    : null
                }
                key={task.id}
                onOpen={() => setOpenDealId(task.dealId)}
                onToggle={() =>
                  toggle.execute({
                    dealId: task.dealId,
                    taskId: task.id,
                    reopen: task.status === "done",
                  })
                }
                overdue={chipTone(task, today) === "overdue"}
                task={task}
                toggleLabel={t(
                  task.status === "done"
                    ? "tasks.mine.reopen"
                    : "tasks.mine.complete",
                  { title: task.title },
                )}
              />
            ))}
          </ul>
        </section>
      ))}
      {!tasks.isLoading && rows.length === 0 ? (
        <p
          className="text-muted-foreground text-sm"
          data-testid="my-tasks-empty"
        >
          {t(status === "open" ? "tasks.mine.empty" : "tasks.mine.emptyDone")}
        </p>
      ) : null}
      {tasks.hasNextPage ? (
        <Button
          className="self-start"
          data-testid="my-tasks-more"
          disabled={tasks.isFetchingNextPage}
          onClick={() => tasks.fetchNextPage()}
          size="sm"
          variant="outline"
        >
          {t("tasks.mine.more")}
        </Button>
      ) : null}
      <CrmDealDrawer
        dealId={openDealId}
        onOpenChange={(open) => {
          if (!open) {
            setOpenDealId(null)
            tasks.refetch()
          }
        }}
        workspaceId={workspaceId}
      />
    </div>
  )
}

function MyTaskRow({
  task,
  dueLabel,
  overdue,
  busy,
  toggleLabel,
  onToggle,
  onOpen,
}: {
  task: DealTaskCalendarResource
  dueLabel: string | null
  overdue: boolean
  busy: boolean
  toggleLabel: string
  onToggle: () => void
  onOpen: () => void
}) {
  return (
    <li
      className="flex items-center gap-3 px-3 py-2"
      data-testid={`my-tasks-row-${task.id}`}
    >
      <Checkbox
        aria-label={toggleLabel}
        checked={task.status === "done"}
        data-testid={`my-tasks-toggle-${task.id}`}
        disabled={busy}
        onCheckedChange={onToggle}
      />
      <button
        className="flex min-w-0 flex-1 flex-col text-start"
        onClick={onOpen}
        type="button"
      >
        <span
          className={cn(
            "truncate text-sm",
            task.status === "done" && "text-muted-foreground line-through",
          )}
        >
          {task.title}
        </span>
        <span className="truncate text-muted-foreground text-xs">
          {task.dealTitle} · {task.pipelineName}
        </span>
      </button>
      {dueLabel ? (
        <span
          className={cn(
            "shrink-0 text-xs",
            overdue ? "text-destructive" : "text-muted-foreground",
          )}
          data-testid={`my-tasks-due-${task.id}`}
        >
          {dueLabel}
        </span>
      ) : null}
    </li>
  )
}
