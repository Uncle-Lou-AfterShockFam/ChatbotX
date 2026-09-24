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
import { LinkIcon, Loader2Icon, PlusIcon, TrashIcon } from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useState } from "react"
import { onActionError } from "@/features/common/lib/on-action-error"
import { completeDealTaskAction } from "@/features/deal-tasks/actions/complete-deal-task-action"
import { createDealTaskAction } from "@/features/deal-tasks/actions/create-deal-task-action"
import { dealDependencyAction } from "@/features/deal-tasks/actions/deal-dependency-action"
import { deleteDealTaskAction } from "@/features/deal-tasks/actions/delete-deal-task-action"
import { useDealTasks } from "@/features/deal-tasks/provider/deal-task-hook"
import type { DealTaskWithBlockersResource } from "@/features/deal-tasks/schema/resource"
import { isOverdue } from "../deal-card"
import { NONE } from "../deal-field-input"

/** Tasks of the deal: complete / reopen, add, wait-on, delete. */
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
  const [title, setTitle] = useState("")
  const [dueAt, setDueAt] = useState("")
  const [assigneeId, setAssigneeId] = useState<string>(NONE)
  const refresh = () => {
    tasks.refetch()
    onChanged()
  }
  const create = useAction(createDealTaskAction.bind(null, workspaceId), {
    onSuccess: () => {
      setTitle("")
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
  const busy =
    create.isPending ||
    toggle.isPending ||
    dependency.isPending ||
    remove.isPending
  const rows = tasks.data ?? []
  const nameOf = (id: string) => rows.find((r) => r.id === id)?.title ?? id
  const assigneeName = (id: string | null) =>
    id ? (ownerOptions.find((o) => o.value === id)?.label ?? id) : null

  return (
    <div className="space-y-3" data-testid="deal-tasks">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (title.trim()) {
            create.execute({
              dealId,
              title: title.trim(),
              dueAt: dueAt ? new Date(`${dueAt}T00:00:00Z`) : null,
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
          aria-label={t("deals.fields.dueAt")}
          className="w-40"
          data-testid="deal-task-due-at"
          onChange={(e) => setDueAt(e.target.value)}
          type="date"
          value={dueAt}
        />
        <Select
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

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t("deals.tasks.none")}</p>
      ) : null}
      <ul className="space-y-2 text-sm">
        {rows.map((task) => (
          <TaskRow
            assigneeName={assigneeName(task.assigneeId)}
            busy={busy}
            format={format}
            key={task.id}
            nameOf={nameOf}
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
      {task.dueAt ? (
        <span
          className={
            overdue
              ? "font-medium text-destructive text-xs"
              : "text-muted-foreground text-xs"
          }
          data-testid={overdue ? `deal-task-overdue-${task.id}` : undefined}
        >
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
