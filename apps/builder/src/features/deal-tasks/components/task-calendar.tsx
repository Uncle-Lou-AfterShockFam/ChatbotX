"use client"

import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@chatbotx.io/ui/components/ui/toggle-group"
import { cn } from "@chatbotx.io/ui/lib/utils"
import { ChevronLeftIcon, ChevronRightIcon, Loader2Icon } from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import { type DragEvent, useMemo, useState } from "react"
import { CrmDealDrawer } from "@/features/crm/components/crm-deal-drawer"
import {
  type ChipTone,
  chipTone,
  droppedDates,
  gridFor,
  gridRange,
  groupByDueDay,
  isSameUtcMonth,
  stepAnchor,
  type TaskCalendarView,
} from "../lib/task-calendar-grid"
import { dayToDate, localToday } from "../lib/timeline-layout"
import { useTasksInRange } from "../provider/deal-task-hook"
import type { DealTaskCalendarResource } from "../schema/resource"
import { useRescheduleTask } from "./use-reschedule-task"

const DRAG_TYPE = "application/x-chatbotx-task"
const TONE_CLASS: Record<ChipTone, string> = {
  open: "border-primary/40 bg-primary/10",
  overdue: "border-destructive/50 bg-destructive/10 text-destructive",
  done: "border-border bg-muted text-muted-foreground line-through",
}

/**
 * Every task due in the visible month / week across the deals the member
 * may see (s197). Click a task to open its deal; drag it to another day to
 * move its due date (a start date moves with it). The same "move the tasks
 * that wait on it too?" question as the deal timeline.
 */
export function TaskCalendar({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations()
  const format = useFormatter()
  const today = localToday()
  const [view, setView] = useState<TaskCalendarView>("month")
  const [anchor, setAnchor] = useState(today)
  const [assignee, setAssignee] = useState<"me" | "any">("me")
  const [openDealId, setOpenDealId] = useState<string | null>(null)
  const [dropDay, setDropDay] = useState<number | null>(null)
  const grid = useMemo(() => gridFor(view, anchor), [view, anchor])
  const range = useMemo(() => gridRange(grid), [grid])
  const tasks = useTasksInRange(workspaceId, { ...range, assignee })
  const rows = tasks.data?.data ?? []
  const byDay = useMemo(() => groupByDueDay(rows), [rows])
  const rescheduler = useRescheduleTask({
    workspaceId,
    onSaved: () => tasks.refetch(),
  })

  const onDrop = (e: DragEvent<HTMLElement>, day: number) => {
    e.preventDefault()
    setDropDay(null)
    // a drop during a save would send dates read from the stale row
    if (rescheduler.isPending) {
      return
    }
    const task = rows.find((r) => r.id === e.dataTransfer.getData(DRAG_TYPE))
    const dates = task ? droppedDates(task, day) : null
    if (task && dates) {
      rescheduler.reschedule(
        {
          dealId: task.dealId,
          taskId: task.id,
          dueAt: task.dueAt,
          openSuccessors: task.openSuccessors,
        },
        dates,
      )
    }
  }
  const title =
    view === "month"
      ? format.dateTime(dayToDate(anchor), {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        })
      : t("tasks.calendar.weekOf", {
          date: format.dateTime(dayToDate(grid[0][0]), {
            dateStyle: "medium",
            timeZone: "UTC",
          }),
        })

  return (
    <div className="flex flex-col gap-4 p-4" data-testid="task-calendar">
      {rescheduler.dialog}
      <div className="flex flex-wrap items-center gap-2">
        <h1
          className="me-auto font-semibold text-lg"
          data-testid="task-calendar-title"
        >
          {title}
        </h1>
        {tasks.isFetching || rescheduler.isPending ? (
          <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
        ) : null}
        <ToggleGroup
          aria-label={t("tasks.calendar.assignee")}
          onValueChange={(value) => {
            const next = value[0]
            if (next === "me" || next === "any") {
              setAssignee(next)
            }
          }}
          size="sm"
          value={[assignee]}
          variant="outline"
        >
          <ToggleGroupItem data-testid="task-calendar-mine" value="me">
            {t("tasks.calendar.mine")}
          </ToggleGroupItem>
          <ToggleGroupItem data-testid="task-calendar-everyone" value="any">
            {t("tasks.calendar.everyone")}
          </ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup
          aria-label={t("tasks.calendar.view")}
          onValueChange={(value) => {
            const next = value[0]
            if (next === "month" || next === "week") {
              setView(next)
            }
          }}
          size="sm"
          value={[view]}
          variant="outline"
        >
          <ToggleGroupItem data-testid="task-calendar-month" value="month">
            {t("tasks.calendar.month")}
          </ToggleGroupItem>
          <ToggleGroupItem data-testid="task-calendar-week" value="week">
            {t("tasks.calendar.week")}
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="flex items-center gap-1">
          <Button
            aria-label={t("tasks.calendar.previous")}
            data-testid="task-calendar-prev"
            onClick={() => setAnchor(stepAnchor(view, anchor, -1))}
            size="icon"
            variant="outline"
          >
            <ChevronLeftIcon className="size-4 rtl:rotate-180" />
          </Button>
          <Button
            data-testid="task-calendar-today"
            onClick={() => setAnchor(today)}
            size="sm"
            variant="outline"
          >
            {t("tasks.calendar.today")}
          </Button>
          <Button
            aria-label={t("tasks.calendar.next")}
            data-testid="task-calendar-next"
            onClick={() => setAnchor(stepAnchor(view, anchor, 1))}
            size="icon"
            variant="outline"
          >
            <ChevronRightIcon className="size-4 rtl:rotate-180" />
          </Button>
        </div>
      </div>
      {tasks.data?.truncated ? (
        <Badge data-testid="task-calendar-truncated" variant="outline">
          {t("tasks.calendar.truncated")}
        </Badge>
      ) : null}
      <div className="overflow-x-auto rounded-md border">
        <div className="grid min-w-[42rem] grid-cols-7">
          {grid[0].map((day) => (
            <div
              className="border-b px-2 py-1 text-muted-foreground text-xs"
              key={`h-${day}`}
            >
              {format.dateTime(dayToDate(day), {
                weekday: "short",
                timeZone: "UTC",
              })}
            </div>
          ))}
          {grid.flat().map((day) => {
            const items = byDay.get(day) ?? []
            const outside = view === "month" && !isSameUtcMonth(day, anchor)
            return (
              // biome-ignore lint/a11y/noNoninteractiveElementInteractions: a day is a drop target only; the keyboard path is the task's date inputs in the deal drawer
              <section
                aria-label={format.dateTime(dayToDate(day), {
                  dateStyle: "full",
                  timeZone: "UTC",
                })}
                className={cn(
                  "flex flex-col gap-1 border-e border-b p-1",
                  view === "month" ? "min-h-24" : "min-h-64",
                  outside && "bg-muted/40",
                  dropDay === day &&
                    "bg-primary/10 ring-2 ring-primary ring-inset",
                )}
                data-testid={`task-calendar-day-${dayToDate(day).toISOString().slice(0, 10)}`}
                key={day}
                onDragLeave={() => setDropDay(null)}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes(DRAG_TYPE)) {
                    e.preventDefault()
                    setDropDay(day)
                  }
                }}
                onDrop={(e) => onDrop(e, day)}
              >
                <span
                  className={cn(
                    "self-end rounded-full px-1.5 text-xs",
                    day === today && "bg-primary text-primary-foreground",
                    outside && day !== today && "text-muted-foreground",
                  )}
                >
                  {dayToDate(day).getUTCDate()}
                </span>
                {items.map((task) => (
                  <TaskChip
                    key={task.id}
                    onOpen={() => setOpenDealId(task.dealId)}
                    task={task}
                    tone={chipTone(task, today)}
                  />
                ))}
              </section>
            )
          })}
        </div>
      </div>
      {!tasks.isLoading && rows.length === 0 ? (
        <p
          className="text-muted-foreground text-sm"
          data-testid="task-calendar-empty"
        >
          {t("tasks.calendar.empty")}
        </p>
      ) : null}
      <p className="text-muted-foreground text-xs">
        {t("tasks.calendar.hint")}
      </p>
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

function TaskChip({
  task,
  tone,
  onOpen,
}: {
  task: DealTaskCalendarResource
  tone: ChipTone
  onOpen: () => void
}) {
  const draggable = task.status === "open"
  return (
    <button
      className={cn(
        "w-full truncate rounded border px-1.5 py-0.5 text-start text-xs",
        draggable && "cursor-grab",
        TONE_CLASS[tone],
      )}
      data-testid={`task-calendar-chip-${task.id}`}
      data-tone={tone}
      draggable={draggable}
      onClick={onOpen}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, task.id)
        e.dataTransfer.effectAllowed = "move"
      }}
      title={`${task.title} - ${task.dealTitle} (${task.pipelineName})`}
      type="button"
    >
      {task.title}
      <span className="block truncate text-[10px] text-muted-foreground">
        {task.dealTitle}
      </span>
    </button>
  )
}
