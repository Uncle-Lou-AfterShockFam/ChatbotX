"use client"

import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Checkbox } from "@chatbotx.io/ui/components/ui/checkbox"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@chatbotx.io/ui/components/ui/toggle-group"
import {
  GanttChartIcon,
  LinkIcon,
  ListIcon,
  Loader2Icon,
  PlusIcon,
  TrashIcon,
} from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useState } from "react"
import { onActionError } from "@/features/common/lib/on-action-error"
import { completeDealTaskAction } from "@/features/deal-tasks/actions/complete-deal-task-action"
import { createDealTaskAction } from "@/features/deal-tasks/actions/create-deal-task-action"
import { dealDependencyAction } from "@/features/deal-tasks/actions/deal-dependency-action"
import { deleteDealTaskAction } from "@/features/deal-tasks/actions/delete-deal-task-action"
import { TasksTimeline } from "@/features/deal-tasks/components/tasks-timeline"
import { useRescheduleTask } from "@/features/deal-tasks/components/use-reschedule-task"
import { openSuccessors } from "@/features/deal-tasks/lib/timeline-layout"
import { useDealTasks } from "@/features/deal-tasks/provider/deal-task-hook"
import type { DealTaskWithBlockersResource } from "@/features/deal-tasks/schema/resource"
import { isOverdue } from "../deal-card"
import { NONE } from "../deal-field-input"

/** A `<input type=date>` value as the UTC midnight the server stores. */
const fromDateInput = (value: string): Date | null =>
  value ? new Date(`${value}T00:00:00Z`) : null
const toDateInput = (value: Date | string | null): string =>
  value ? new Date(value).toISOString().slice(0, 10) : ""

/** Tasks of the deal: list (complete / reopen, add, wait-on, dates, delete) or timeline. */
export function DealTasksPanel({
  workspaceId,
  dealId,
  ownerOptions,
  onChanged,
}: {
  workspaceId: string
  dealId: string
  ownerOptions: { label: string; value: string }[]
  onChanged: () => void
}) {
  const t = useTranslations()
  const format = useFormatter()
  const tasks = useDealTasks(workspaceId, dealId)
  const [view, setView] = useState<"list" | "timeline">("list")
  const [title, setTitle] = useState("")
  const [startAt, setStartAt] = useState("")
  const [dueAt, setDueAt] = useState("")
  const [assigneeId, setAssigneeId] = useState<string>(NONE)
  const refresh = () => {
    tasks.refetch()
    onChanged()
  }
  const create = useAction(createDealTaskAction.bind(null, workspaceId), {
    onSuccess: () => {
      setTitle("")
      setStartAt("")
      setDueAt("")
      setAssigneeId(NONE)
      refresh()
    },
    onError: onActionError,
  })
  const toggle = useAction(completeDealTaskAction.bind(null, workspaceId), {
    onSuccess: refresh,
    onError: onActionError,
  })
  const dependency = useAction(dealDependencyAction.bind(null, workspaceId), {
    onSuccess: refresh,
    onError: onActionError,
  })
  const remove = useAction(deleteDealTaskAction.bind(null, workspaceId), {
    onSuccess: refresh,
    onError: onActionError,
  })
  const rows = tasks.data ?? []
  const rescheduler = useRescheduleTask({ workspaceId, onSaved: refresh })
  const reschedule = {
    ...rescheduler,
    reschedule: (
      taskId: string,
      dates: { startAt?: Date | null; dueAt?: Date | null },
    ) =>
      rescheduler.reschedule(
        {
          dealId,
          taskId,
          dueAt: rows.find((r) => r.id === taskId)?.dueAt ?? null,
          openSuccessors: openSuccessors(rows, taskId).length,
        },
        dates,
      ),
  }

  const busy =
    create.isPending ||
    toggle.isPending ||
    dependency.isPending ||
    remove.isPending ||
    reschedule.isPending
  const nameOf = (id: string) => rows.find((r) => r.id === id)?.title ?? id
  const assigneeName = (id: string | null) =>
    id ? (ownerOptions.find((o) => o.value === id)?.label ?? id) : null

  return (
    <div className="space-y-3" data-testid="deal-tasks">
      {reschedule.dialog}
      <ToggleGroup
        aria-label={t("deals.tasks.view")}
        onValueChange={(value) => {
          const next = value[0]
          if (next === "list" || next === "timeline") {
            setView(next)
          }
        }}
        size="sm"
        value={[view]}
        variant="outline"
      >
        <ToggleGroupItem data-testid="deal-tasks-view-list" value="list">
          <ListIcon className="size-4" />
          {t("deals.tasks.list")}
        </ToggleGroupItem>
        <ToggleGroupItem
          data-testid="deal-tasks-view-timeline"
          value="timeline"
        >
          <GanttChartIcon className="size-4" />
          {t("deals.tasks.timeline")}
        </ToggleGroupItem>
      </ToggleGroup>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (title.trim()) {
            create.execute({
              dealId,
              title: title.trim(),
              startAt: fromDateInput(startAt),
              dueAt: fromDateInput(dueAt),
              assigneeId: assigneeId === NONE ? null : assigneeId,
            })
          }
        }}
      >
        <Input
          aria-label={t("deals.tasks.titlePlaceholder")}
          className="min-w-40 flex-1"
          data-testid="deal-task-title"
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("deals.tasks.titlePlaceholder")}
          value={title}
        />
        <Input
          aria-label={t("deals.tasks.startAt")}
          className="w-36"
          data-testid="deal-task-start-at"
          max={dueAt || undefined}
          onChange={(e) => setStartAt(e.target.value)}
          title={t("deals.tasks.startAt")}
          type="date"
          value={startAt}
        />
        <Input
          aria-label={t("deals.fields.dueAt")}
          className="w-36"
          data-testid="deal-task-due-at"
          min={startAt || undefined}
          onChange={(e) => setDueAt(e.target.value)}
          title={t("deals.fields.dueAt")}
          type="date"
          value={dueAt}
        />
        <Select
          items={[
            { value: NONE, label: t("deals.tasks.unassigned") },
            ...ownerOptions,
          ]}
          onValueChange={(v) => setAssigneeId(String(v ?? NONE))}
          value={assigneeId}
        >
          <SelectTrigger className="w-40" data-testid="deal-task-assignee">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t("deals.tasks.unassigned")}</SelectItem>
            {ownerOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          data-testid="deal-task-add"
          disabled={busy || title.trim().length === 0}
          size="sm"
          type="submit"
        >
          {create.isPending ? (
            <Loader2Icon className="animate-spin" />
          ) : (
            <PlusIcon />
          )}
          {t("deals.tasks.add")}
        </Button>
      </form>

      {view === "timeline" ? (
        <TasksTimeline
          busy={busy}
          onReschedule={reschedule.reschedule}
          tasks={rows}
        />
      ) : null}
      {view === "list" && rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t("deals.tasks.none")}</p>
      ) : null}
      <ul className={view === "list" ? "space-y-2 text-sm" : "hidden"}>
        {rows.map((task) => (
          <TaskRow
            assigneeName={assigneeName(task.assigneeId)}
            busy={busy}
            format={format}
            key={task.id}
            nameOf={nameOf}
            onDates={(dates) => reschedule.reschedule(task.id, dates)}
            onDependency={(dependsOnTaskId, removeEdge) =>
              dependency.execute({
                dealId,
                taskId: task.id,
                dependsOnTaskId,
                remove: removeEdge,
              })
            }
            onRemove={() => remove.execute({ dealId, taskId: task.id })}
            onToggle={() =>
              toggle.execute({
                dealId,
                taskId: task.id,
                reopen: task.status === "done",
              })
            }
            others={rows.filter((r) => r.id !== task.id)}
            task={task}
          />
        ))}
      </ul>
    </div>
  )
}

function TaskRow({
  task,
  others,
  assigneeName,
  nameOf,
  busy,
  format,
  onToggle,
  onDependency,
  onDates,
  onRemove,
}: {
  task: DealTaskWithBlockersResource
  others: DealTaskWithBlockersResource[]
  assigneeName: string | null
  nameOf: (id: string) => string
  busy: boolean
  format: ReturnType<typeof useFormatter>
  onToggle: () => void
  onDependency: (dependsOnTaskId: string, remove: boolean) => void
  onDates: (dates: { startAt?: Date | null; dueAt?: Date | null }) => void
  onRemove: () => void
}) {
  const t = useTranslations()
  const blocked = task.status === "open" && task.blockedBy.length > 0
  const overdue = isOverdue({ status: task.status, dueAt: task.dueAt })
  const [pick, setPick] = useState<string>(NONE)
  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded-md border p-2"
      data-testid={`deal-task-${task.id}`}
    >
      <Checkbox
        aria-label={task.title}
        checked={task.status === "done"}
        data-testid={`deal-task-toggle-${task.id}`}
        disabled={busy || blocked}
        onCheckedChange={onToggle}
        title={blocked ? t("deals.tasks.blockedHint") : undefined}
      />
      <span
        className={
          task.status === "done" ? "text-muted-foreground line-through" : ""
        }
        data-testid={`deal-task-title-${task.id}`}
      >
        {task.title}
      </span>
      {blocked ? (
        <Badge data-testid={`deal-task-blocked-${task.id}`} variant="outline">
          {t("deals.tasks.blockedBy", {
            tasks: task.blockedBy.map(nameOf).join(", "),
          })}
        </Badge>
      ) : null}
      {task.conflicts.length > 0 ? (
        <Badge
          data-testid={`deal-task-conflict-${task.id}`}
          variant="destructive"
        >
          {t("deals.tasks.startsBefore", {
            tasks: task.conflicts.map(nameOf).join(", "),
          })}
        </Badge>
      ) : null}
      {task.status === "open" ? (
        <span className="flex items-center gap-1">
          <Input
            aria-label={t("deals.tasks.startAt")}
            className="h-7 w-34 text-xs"
            data-testid={`deal-task-start-${task.id}`}
            defaultValue={toDateInput(task.startAt)}
            disabled={busy}
            key={`s-${toDateInput(task.startAt)}`}
            onBlur={(e) => {
              if (e.target.value !== toDateInput(task.startAt)) {
                onDates({ startAt: fromDateInput(e.target.value) })
              }
            }}
            title={t("deals.tasks.startAt")}
            type="date"
          />
          <Input
            aria-label={t("deals.fields.dueAt")}
            className={
              overdue
                ? "h-7 w-34 border-destructive text-destructive text-xs"
                : "h-7 w-34 text-xs"
            }
            data-testid={`deal-task-due-${task.id}`}
            defaultValue={toDateInput(task.dueAt)}
            disabled={busy}
            key={`d-${toDateInput(task.dueAt)}`}
            onBlur={(e) => {
              if (e.target.value !== toDateInput(task.dueAt)) {
                onDates({ dueAt: fromDateInput(e.target.value) })
              }
            }}
            title={t("deals.fields.dueAt")}
            type="date"
          />
          {overdue ? (
            <span
              className="font-medium text-destructive text-xs"
              data-testid={`deal-task-overdue-${task.id}`}
            >
              {t("deals.overdue")}
            </span>
          ) : null}
        </span>
      ) : null}
      {task.status === "done" && task.dueAt ? (
        <span className="text-muted-foreground text-xs">
          {format.dateTime(task.dueAt, {
            dateStyle: "medium",
            timeZone: "UTC",
          })}
        </span>
      ) : null}
      {assigneeName ? (
        <span className="text-muted-foreground text-xs">{assigneeName}</span>
      ) : null}
      <div className="ml-auto flex items-center gap-1">
        {others.length > 0 ? (
          <Select
            items={[
              { value: NONE, label: t("deals.tasks.waitOn") },
              ...others.map((o) => ({ value: o.id, label: o.title })),
            ]}
            onValueChange={(v) => {
              const id = String(v ?? "")
              if (id && id !== NONE) {
                // Toggle on the STORED edge, not on "currently blocking".
                onDependency(id, task.dependsOn.includes(id))
                setPick(NONE)
              }
            }}
            value={pick}
          >
            <SelectTrigger
              aria-label={t("deals.tasks.waitOn")}
              className="w-40"
              data-testid={`deal-task-wait-on-${task.id}`}
            >
              <LinkIcon className="size-3" />
              <SelectValue placeholder={t("deals.tasks.waitOn")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t("deals.tasks.waitOn")}</SelectItem>
              {others.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {task.dependsOn.includes(o.id) ? "✓ " : ""}
                  {o.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Button
          aria-label={t("actions.delete")}
          data-testid={`deal-task-delete-${task.id}`}
          disabled={busy}
          onClick={onRemove}
          size="icon"
          variant="ghost"
        >
          <TrashIcon className="size-4" />
        </Button>
      </div>
    </li>
  )
}
