"use client"

import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@chatbotx.io/ui/components/ui/card"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import {
  Sortable,
  SortableContent,
  SortableItem,
  SortableItemHandle,
} from "@chatbotx.io/ui/components/ui/sortable"
import { Switch } from "@chatbotx.io/ui/components/ui/switch"
import {
  GripVerticalIcon,
  Loader2Icon,
  PlusIcon,
  TrashIcon,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useState } from "react"
import { toast } from "sonner"
import { ConfirmButton } from "@/components/confirm-button"
import {
  createPipelineAction,
  deletePipelineAction,
  removeStageAction,
  reorderStagesAction,
  updatePipelineAction,
  upsertStageAction,
} from "./actions/pipeline-actions"
import { FieldDefsEditor } from "./field-defs-editor"
import { PipelineMembersEditor } from "./pipeline-members-editor"
import { useInvalidatePipelines } from "./provider/pipeline-hook"
import type {
  PipelineStageResource,
  PipelineWithStagesResource,
} from "./schema/resource"
import { StageTaskTemplates } from "./stage-task-templates"

const onActionError = ({ error }: { error: { serverError?: string } }) => {
  if (error.serverError) {
    toast.error(error.serverError)
  }
}

function moveItem<T>(items: T[], from: number, to: number): T[] {
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

function StageRow({
  workspaceId,
  pipelineId,
  stage,
  stages,
  onChanged,
}: {
  workspaceId: string
  pipelineId: string
  stage: PipelineStageResource
  stages: PipelineStageResource[]
  onChanged: () => void
}) {
  const t = useTranslations()
  const [name, setName] = useState(stage.name)
  const [probability, setProbability] = useState(String(stage.probability))
  const [color, setColor] = useState(stage.color ?? "")
  const [moveTo, setMoveTo] = useState<string>("")
  const upsert = useAction(upsertStageAction.bind(null, workspaceId), {
    onSuccess: onChanged,
    onError: onActionError,
  })
  const remove = useAction(removeStageAction.bind(null, workspaceId), {
    onSuccess: ({ data }) => {
      if (data && data.movedDeals > 0) {
        toast.success(t("deals.stageRemovedMoved", { count: data.movedDeals }))
      }
      onChanged()
    },
    onError: onActionError,
  })
  const save = (
    patch: Partial<{
      name: string
      probability: number
      color: string | null
      isWon: boolean
      isLost: boolean
    }>,
  ) =>
    upsert.execute({
      pipelineId,
      stageId: stage.id,
      name: patch.name ?? name,
      probability: patch.probability ?? (Number(probability) || 0),
      color: patch.color === undefined ? color || null : patch.color,
      isWon: patch.isWon ?? stage.isWon,
      isLost: patch.isLost ?? stage.isLost,
    })
  const others = stages.filter((s) => s.id !== stage.id)

  return (
    <SortableItem
      render={
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border bg-background p-2"
          data-testid={`stage-row-${stage.id}`}
          role="presentation"
        >
          <SortableItemHandle
            render={
              <Button
                aria-label={t("deals.reorder")}
                size="icon"
                variant="ghost"
              >
                <GripVerticalIcon className="size-4" />
              </Button>
            }
          />
          <Input
            aria-label={t("fields.name.label")}
            className="w-40"
            onBlur={() =>
              name.trim() && name !== stage.name && save({ name: name.trim() })
            }
            onChange={(e) => setName(e.target.value)}
            value={name}
          />
          <Input
            aria-label={t("deals.fields.color")}
            className="w-28"
            onBlur={() =>
              (color || null) !== stage.color && save({ color: color || null })
            }
            onChange={(e) => setColor(e.target.value)}
            placeholder="#22c55e"
            value={color}
          />
          <Input
            aria-label={t("deals.fields.probability")}
            className="w-20"
            inputMode="numeric"
            onBlur={() =>
              Number(probability) !== stage.probability &&
              save({ probability: Number(probability) || 0 })
            }
            onChange={(e) => setProbability(e.target.value)}
            value={probability}
          />
          <div className="flex items-center gap-1 text-xs">
            <Switch
              checked={stage.isWon}
              onCheckedChange={(checked) =>
                save({ isWon: checked, isLost: checked ? false : stage.isLost })
              }
            />
            {t("deals.statuses.won")}
          </div>
          <div className="flex items-center gap-1 text-xs">
            <Switch
              checked={stage.isLost}
              onCheckedChange={(checked) =>
                save({ isLost: checked, isWon: checked ? false : stage.isWon })
              }
            />
            {t("deals.statuses.lost")}
          </div>
          <div className="ml-auto flex items-center gap-1">
            <StageTaskTemplates
              pipelineId={pipelineId}
              stageId={stage.id}
              workspaceId={workspaceId}
            />
            {others.length > 0 ? (
              <Select
                items={others.map((s) => ({ value: s.id, label: s.name }))}
                onValueChange={(v) => setMoveTo(String(v ?? ""))}
                value={moveTo}
              >
                <SelectTrigger
                  aria-label={t("deals.moveDealsTo")}
                  className="w-40"
                >
                  <SelectValue placeholder={t("deals.moveDealsTo")} />
                </SelectTrigger>
                <SelectContent>
                  {others.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Button
              aria-label={t("actions.delete")}
              data-testid={`stage-remove-${stage.id}`}
              disabled={remove.isPending}
              onClick={() =>
                remove.execute({
                  pipelineId,
                  stageId: stage.id,
                  moveDealsTo: moveTo || null,
                })
              }
              size="icon"
              variant="ghost"
            >
              <TrashIcon className="size-4" />
            </Button>
          </div>
        </div>
      }
      value={stage.id}
    />
  )
}

function PipelineCard({
  workspaceId,
  pipeline,
  onChanged,
}: {
  workspaceId: string
  pipeline: PipelineWithStagesResource
  onChanged: () => void
}) {
  const t = useTranslations()
  const [name, setName] = useState(pipeline.name)
  const [currency, setCurrency] = useState(pipeline.settings.defaultCurrency)
  const [newStage, setNewStage] = useState("")
  const [stages, setStages] = useState(pipeline.stages)
  const [syncedStages, setSyncedStages] = useState(pipeline.stages)
  if (syncedStages !== pipeline.stages) {
    setSyncedStages(pipeline.stages)
    setStages(pipeline.stages)
  }

  const update = useAction(updatePipelineAction.bind(null, workspaceId), {
    onSuccess: onChanged,
    onError: onActionError,
  })
  const addStage = useAction(upsertStageAction.bind(null, workspaceId), {
    onSuccess: () => {
      setNewStage("")
      onChanged()
    },
    onError: onActionError,
  })
  const reorder = useAction(reorderStagesAction.bind(null, workspaceId), {
    onSuccess: onChanged,
    onError: (e) => {
      onActionError(e)
      onChanged()
    },
  })
  const remove = useAction(deletePipelineAction.bind(null, workspaceId), {
    onSuccess: () => {
      toast.success(
        t("messages.deletedSuccess", { feature: t("deals.pipeline") }),
      )
      onChanged()
    },
    onError: onActionError,
  })

  return (
    <Card data-testid={`pipeline-${pipeline.id}`}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={t("fields.name.label")}
            className="w-56 font-semibold"
            onBlur={() =>
              name.trim() &&
              name !== pipeline.name &&
              update.execute({ id: pipeline.id, name: name.trim() })
            }
            onChange={(e) => setName(e.target.value)}
            value={name}
          />
          <Badge variant="outline">
            {t("deals.stageCount", { count: pipeline.stages.length })}
          </Badge>
          <ConfirmButton
            className="ml-auto"
            data-testid={`pipeline-delete-${pipeline.id}`}
            description={t("deals.deletePipelineConfirm")}
            disabled={remove.isPending}
            onConfirm={() => remove.execute({ id: pipeline.id, force: true })}
            size="sm"
            title={t("messages.deleteFeature", {
              feature: t("deals.pipeline"),
            })}
            variant="destructive"
          >
            <TrashIcon />
            {t("actions.delete")}
          </ConfirmButton>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1 text-sm">
            <span className="text-muted-foreground text-xs">
              {t("deals.stopCompanyOn")}
            </span>
            <Select
              items={(["none", "created", "won"] as const).map((v) => ({
                value: v,
                label: t(`deals.stopCompanyOnOptions.${v}`),
              }))}
              onValueChange={(v) =>
                v &&
                update.execute({
                  id: pipeline.id,
                  settings: { stopCompanyOn: v as "none" | "created" | "won" },
                })
              }
              value={pipeline.settings.stopCompanyOn}
            >
              <SelectTrigger data-testid={`pipeline-stop-${pipeline.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["none", "created", "won"] as const).map((v) => (
                  <SelectItem key={v} value={v}>
                    {t(`deals.stopCompanyOnOptions.${v}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="block text-muted-foreground text-xs">
              {t("deals.stopCompanyOnHint")}
            </span>
          </div>
          <div className="space-y-1 text-sm">
            <span className="text-muted-foreground text-xs">
              {t("deals.defaultCurrency")}
            </span>
            <Input
              className="w-24 uppercase"
              maxLength={3}
              onBlur={() =>
                currency.trim().length === 3 &&
                currency.toUpperCase() !== pipeline.settings.defaultCurrency &&
                update.execute({
                  id: pipeline.id,
                  settings: { defaultCurrency: currency.toUpperCase() },
                })
              }
              onChange={(e) => setCurrency(e.target.value)}
              value={currency}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1 text-sm">
            <span className="text-muted-foreground text-xs">
              {t("deals.assignOwner")}
            </span>
            <Select
              items={(["none", "roundRobin"] as const).map((v) => ({
                value: v,
                label: t(`deals.assignOwnerOptions.${v}`),
              }))}
              onValueChange={(v) =>
                v &&
                update.execute({
                  id: pipeline.id,
                  settings: { assignOwner: v as "none" | "roundRobin" },
                })
              }
              value={pipeline.settings.assignOwner}
            >
              <SelectTrigger data-testid={`pipeline-assign-${pipeline.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["none", "roundRobin"] as const).map((v) => (
                  <SelectItem key={v} value={v}>
                    {t(`deals.assignOwnerOptions.${v}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="block text-muted-foreground text-xs">
              {t("deals.assignOwnerHint")}
            </span>
          </div>
          <div className="space-y-1 text-sm">
            <span className="text-muted-foreground text-xs">
              {t("deals.access")}
            </span>
            <Select
              items={(["workspace", "members"] as const).map((v) => ({
                value: v,
                label: t(`deals.accessOptions.${v}`),
              }))}
              onValueChange={(v) =>
                v &&
                update.execute({
                  id: pipeline.id,
                  settings: { access: v as "workspace" | "members" },
                })
              }
              value={pipeline.settings.access}
            >
              <SelectTrigger data-testid={`pipeline-access-${pipeline.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["workspace", "members"] as const).map((v) => (
                  <SelectItem key={v} value={v}>
                    {t(`deals.accessOptions.${v}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="block text-muted-foreground text-xs">
              {t("deals.accessHint")}
            </span>
          </div>
        </div>

        <PipelineMembersEditor
          pipelineId={pipeline.id}
          workspaceId={workspaceId}
        />

        <FieldDefsEditor
          fieldDefs={pipeline.settings.fieldDefs}
          onSave={(fieldDefs) =>
            update.execute({ id: pipeline.id, settings: { fieldDefs } })
          }
          pipelineId={pipeline.id}
          saving={update.isPending}
        />

        <div className="space-y-2">
          <div className="font-medium text-sm">{t("deals.stages")}</div>
          <Sortable
            getItemValue={(stage: PipelineStageResource) => stage.id}
            onMove={({ activeIndex, overIndex }) => {
              const next = moveItem(stages, activeIndex, overIndex)
              setStages(next)
              reorder.execute({
                pipelineId: pipeline.id,
                stageIds: next.map((s) => s.id),
              })
            }}
            value={stages}
          >
            <SortableContent>
              <div className="flex flex-col gap-2">
                {stages.map((stage) => (
                  <StageRow
                    key={stage.id}
                    onChanged={onChanged}
                    pipelineId={pipeline.id}
                    stage={stage}
                    stages={stages}
                    workspaceId={workspaceId}
                  />
                ))}
              </div>
            </SortableContent>
          </Sortable>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (newStage.trim()) {
                addStage.execute({
                  pipelineId: pipeline.id,
                  name: newStage.trim(),
                })
              }
            }}
          >
            <Input
              data-testid={`new-stage-${pipeline.id}`}
              onChange={(e) => setNewStage(e.target.value)}
              placeholder={t("deals.newStagePlaceholder")}
              value={newStage}
            />
            <Button
              disabled={addStage.isPending || newStage.trim().length === 0}
              size="sm"
              type="submit"
            >
              {addStage.isPending ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <PlusIcon />
              )}
              {t("deals.addStage")}
            </Button>
          </form>
        </div>
      </CardContent>
    </Card>
  )
}

export function PipelinesSettings({
  workspaceId,
  pipelines,
}: {
  workspaceId: string
  pipelines: PipelineWithStagesResource[]
}) {
  const t = useTranslations()
  const router = useRouter()
  const invalidate = useInvalidatePipelines()
  const [newName, setNewName] = useState("")
  const onChanged = () => {
    invalidate()
    router.refresh()
  }
  const create = useAction(createPipelineAction.bind(null, workspaceId), {
    onSuccess: () => {
      toast.success(
        t("messages.createdSuccess", { feature: t("deals.pipeline") }),
      )
      setNewName("")
      onChanged()
    },
    onError: onActionError,
  })

  return (
    <div className="space-y-4">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (newName.trim()) {
            create.execute({ name: newName.trim() })
          }
        }}
      >
        <Input
          data-testid="new-pipeline-name"
          onChange={(e) => setNewName(e.target.value)}
          placeholder={t("deals.newPipelinePlaceholder")}
          value={newName}
        />
        <Button
          data-testid="create-pipeline"
          disabled={create.isPending || newName.trim().length === 0}
          size="sm"
          type="submit"
        >
          {create.isPending ? (
            <Loader2Icon className="animate-spin" />
          ) : (
            <PlusIcon />
          )}
          {t("messages.createFeature", { feature: t("deals.pipeline") })}
        </Button>
      </form>
      {pipelines.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t("deals.noPipelinesSettings")}
        </p>
      ) : null}
      {pipelines.map((pipeline) => (
        <PipelineCard
          key={pipeline.id}
          onChanged={onChanged}
          pipeline={pipeline}
          workspaceId={workspaceId}
        />
      ))}
    </div>
  )
}
