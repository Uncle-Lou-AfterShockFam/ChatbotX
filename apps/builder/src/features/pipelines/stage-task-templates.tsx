"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@chatbotx.io/ui/components/ui/dialog"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import { Switch } from "@chatbotx.io/ui/components/ui/switch"
import {
  LinkIcon,
  ListChecksIcon,
  Loader2Icon,
  PlusIcon,
  TrashIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useState } from "react"
import { onActionError } from "@/features/common/lib/on-action-error"
import {
  removeTaskTemplateAction,
  taskTemplateDependencyAction,
  upsertTaskTemplateAction,
} from "@/features/deal-tasks/actions/task-template-actions"
import { usePipelineTaskTemplates } from "@/features/deal-tasks/provider/deal-task-hook"
import { NONE } from "@/features/deals/deal-field-input"
import { useOwnerOptions } from "@/features/deals/provider/deal-hook"

/** "Tasks (n)" button on a stage row -> dialog listing the stage's task templates. */
export function StageTaskTemplates({
  workspaceId,
  pipelineId,
  stageId,
}: {
  workspaceId: string
  pipelineId: string
  stageId: string
}) {
  const t = useTranslations()
  const [open, setOpen] = useState(false)
  const templates = usePipelineTaskTemplates(workspaceId, pipelineId)
  const rows = (templates.data ?? []).filter((tpl) => tpl.stageId === stageId)
  const ownerOptions = useOwnerOptions(workspaceId, { enabled: open })
  const [title, setTitle] = useState("")
  const [startInDays, setStartInDays] = useState("")
  const [dueInDays, setDueInDays] = useState("")
  const [assignToOwner, setAssignToOwner] = useState(true)
  const [assigneeId, setAssigneeId] = useState<string>(NONE)
  const upsert = useAction(upsertTaskTemplateAction.bind(null, workspaceId), {
    onSuccess: () => {
      setTitle("")
      setStartInDays("")
      setDueInDays("")
      templates.refetch()
    },
    onError: onActionError,
  })
  const remove = useAction(removeTaskTemplateAction.bind(null, workspaceId), {
    onSuccess: () => templates.refetch(),
    onError: onActionError,
  })
  const dependency = useAction(
    taskTemplateDependencyAction.bind(null, workspaceId),
    {
      onSuccess: () => templates.refetch(),
      onError: onActionError,
    },
  )
  const nameOf = (id: string) => rows.find((r) => r.id === id)?.title ?? id

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={
          <Button
            data-testid={`stage-tasks-${stageId}`}
            size="sm"
            type="button"
            variant="outline"
          >
            <ListChecksIcon className="size-4" />
            {t("deals.taskTemplates.button", { count: rows.length })}
          </Button>
        }
      />
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("deals.taskTemplates.title")}</DialogTitle>
          <DialogDescription>{t("deals.taskTemplates.hint")}</DialogDescription>
        </DialogHeader>
        <ul
          className="space-y-2 text-sm"
          data-testid={`stage-task-templates-${stageId}`}
        >
          {rows.map((tpl) => (
            <li
              className="flex flex-wrap items-center gap-2 rounded-md border p-2"
              data-testid={`task-template-${tpl.id}`}
              key={tpl.id}
            >
              <span className="min-w-24 flex-1">
                {tpl.title}
                {tpl.dependsOn.length > 0 ? (
                  <span
                    className="block text-muted-foreground text-xs"
                    data-testid={`task-template-waits-${tpl.id}`}
                  >
                    {t("deals.taskTemplates.waitsOn", {
                      tasks: tpl.dependsOn.map(nameOf).join(", "),
                    })}
                  </span>
                ) : null}
              </span>
              {tpl.startInDays === null ? null : (
                <span className="text-muted-foreground text-xs">
                  {t("deals.taskTemplates.startIn", {
                    count: tpl.startInDays,
                  })}
                </span>
              )}
              <span className="text-muted-foreground text-xs">
                {tpl.dueInDays === null
                  ? t("deals.taskTemplates.noDue")
                  : t("deals.taskTemplates.dueIn", { count: tpl.dueInDays })}
              </span>
              <span className="text-muted-foreground text-xs">
                {tpl.assignToOwner
                  ? t("deals.taskTemplates.toOwner")
                  : (ownerOptions.find((o) => o.value === tpl.assigneeId)
                      ?.label ?? t("deals.tasks.unassigned"))}
              </span>
              {rows.length > 1 ? (
                <Select
                  items={[
                    { value: NONE, label: t("deals.tasks.waitOn") },
                    ...rows
                      .filter((o) => o.id !== tpl.id)
                      .map((o) => ({ value: o.id, label: o.title })),
                  ]}
                  onValueChange={(v) => {
                    const id = String(v ?? "")
                    if (id && id !== NONE) {
                      dependency.execute({
                        pipelineId,
                        stageId,
                        templateId: tpl.id,
                        dependsOnTemplateId: id,
                        remove: tpl.dependsOn.includes(id),
                      })
                    }
                  }}
                  value={NONE}
                >
                  <SelectTrigger
                    aria-label={t("deals.tasks.waitOn")}
                    className="w-36"
                    data-testid={`task-template-wait-on-${tpl.id}`}
                    disabled={dependency.isPending}
                  >
                    <LinkIcon className="size-3" />
                    <SelectValue placeholder={t("deals.tasks.waitOn")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>
                      {t("deals.tasks.waitOn")}
                    </SelectItem>
                    {rows
                      .filter((o) => o.id !== tpl.id)
                      .map((o) => (
                        <SelectItem key={o.id} value={o.id}>
                          {tpl.dependsOn.includes(o.id) ? "✓ " : ""}
                          {o.title}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              ) : null}
              <Button
                aria-label={t("actions.delete")}
                data-testid={`task-template-remove-${tpl.id}`}
                disabled={remove.isPending}
                onClick={() =>
                  remove.execute({ pipelineId, stageId, templateId: tpl.id })
                }
                size="icon"
                variant="ghost"
              >
                <TrashIcon className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (title.trim()) {
              upsert.execute({
                pipelineId,
                stageId,
                title: title.trim(),
                startInDays: startInDays === "" ? null : Number(startInDays),
                dueInDays: dueInDays === "" ? null : Number(dueInDays),
                assignToOwner,
                assigneeId:
                  assignToOwner || assigneeId === NONE ? null : assigneeId,
              })
            }
          }}
        >
          <Input
            aria-label={t("deals.tasks.titlePlaceholder")}
            className="min-w-40 flex-1"
            data-testid="task-template-title"
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("deals.tasks.titlePlaceholder")}
            value={title}
          />
          <Input
            aria-label={t("deals.startInDays")}
            className="w-28"
            data-testid="task-template-start-in-days"
            inputMode="numeric"
            max={365}
            min={0}
            onChange={(e) => setStartInDays(e.target.value)}
            placeholder={t("deals.startInDays")}
            type="number"
            value={startInDays}
          />
          <Input
            aria-label={t("deals.dueInDays")}
            className="w-28"
            data-testid="task-template-due-in-days"
            inputMode="numeric"
            max={365}
            min={0}
            onChange={(e) => setDueInDays(e.target.value)}
            placeholder={t("deals.dueInDays")}
            type="number"
            value={dueInDays}
          />
          <div className="flex items-center gap-1 text-xs">
            <Switch
              aria-label={t("deals.taskTemplates.toOwner")}
              checked={assignToOwner}
              data-testid="task-template-assign-owner"
              onCheckedChange={setAssignToOwner}
              size="sm"
            />
            {t("deals.taskTemplates.toOwner")}
          </div>
          {assignToOwner ? null : (
            <Select
              items={[
                { value: NONE, label: t("deals.tasks.unassigned") },
                ...ownerOptions,
              ]}
              onValueChange={(v) => setAssigneeId(String(v ?? NONE))}
              value={assigneeId}
            >
              <SelectTrigger
                className="w-40"
                data-testid="task-template-assignee"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>
                  {t("deals.tasks.unassigned")}
                </SelectItem>
                {ownerOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            data-testid="task-template-add"
            disabled={upsert.isPending || title.trim().length === 0}
            size="sm"
            type="submit"
          >
            {upsert.isPending ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <PlusIcon />
            )}
            {t("deals.taskTemplates.add")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
