"use client"

import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@chatbotx.io/ui/components/ui/sheet"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@chatbotx.io/ui/components/ui/tabs"
import {
  RotateCcwIcon,
  ThumbsDownIcon,
  TrashIcon,
  TrophyIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { ConfirmButton } from "@/components/confirm-button"
import type { PipelineWithStagesResource } from "@/features/pipelines/schema/resource"
import { addDealNoteAction } from "../actions/add-deal-note-action"
import { deleteDealsAction } from "../actions/delete-deals-action"
import { moveDealAction } from "../actions/move-deal-action"
import { setDealStatusAction } from "../actions/set-deal-status-action"
import { updateDealAction } from "../actions/update-deal-action"
import { namesById } from "../lib/names-by-id"
import { useDealActivities, useOwnerOptions } from "../provider/deal-hook"
import type { DealResource } from "../schema/resource"
import { DealActivityList } from "./activity-list"
import { DealCommentsPanel } from "./comments-panel"
import { DealDetailsForm } from "./details-form"
import { MovePipelineDialog } from "./move-pipeline-dialog"
import { DealTasksPanel } from "./tasks-panel"

export { describeActivity } from "./activity-list"

const onActionError = ({ error }: { error: { serverError?: string } }) => {
  if (error.serverError) {
    toast.error(error.serverError)
  }
}

/** The deal sheet: editable title, status badge, then Details / Activity tabs. */
export function DealDrawer({
  workspaceId,
  deal,
  pipeline,
  stageNames: allStageNames,
  onOpenChange,
  onChanged,
  onPipelineMoved,
}: {
  workspaceId: string
  deal: DealResource | null
  pipeline: PipelineWithStagesResource | null
  /** `namesById` over EVERY pipeline, so a cross-pipeline move's old stages still read as names (s196). */
  stageNames?: ReadonlyMap<string, string>
  onOpenChange: (open: boolean) => void
  onChanged: () => void
  /** The deal left for another pipeline (s196); the caller follows it. */
  onPipelineMoved?: (pipelineId: string) => void
}) {
  const t = useTranslations()
  const open = deal !== null
  const ownerOptions = useOwnerOptions(workspaceId, { enabled: open })
  const activities = useDealActivities(workspaceId, deal?.id)
  const stageNames = new Map([
    ...(allStageNames ?? []),
    ...namesById(pipeline ? [pipeline] : []),
  ])

  const [title, setTitle] = useState("")
  const [note, setNote] = useState("")
  useEffect(() => {
    setTitle(deal?.title ?? "")
    setNote("")
  }, [deal?.title])

  const refresh = () => {
    onChanged()
    activities.refetch()
  }
  const update = useAction(updateDealAction.bind(null, workspaceId), {
    onSuccess: refresh,
    onError: onActionError,
  })
  const move = useAction(moveDealAction.bind(null, workspaceId), {
    onSuccess: refresh,
    onError: onActionError,
  })
  const setStatus = useAction(setDealStatusAction.bind(null, workspaceId), {
    onSuccess: refresh,
    onError: onActionError,
  })
  const addNote = useAction(addDealNoteAction.bind(null, workspaceId), {
    onSuccess: () => {
      setNote("")
      refresh()
    },
    onError: onActionError,
  })
  const remove = useAction(deleteDealsAction.bind(null, workspaceId), {
    onSuccess: () => {
      toast.success(t("messages.deletedSuccess", { feature: t("deals.one") }))
      onOpenChange(false)
      onChanged()
    },
    onError: onActionError,
  })
  const busy =
    update.isPending ||
    move.isPending ||
    setStatus.isPending ||
    addNote.isPending ||
    remove.isPending

  if (!deal) {
    return <Sheet onOpenChange={onOpenChange} open={false} />
  }
  const id = deal.id

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent
        // the sheet body has no padding of its own: 16 px gutters here, the
        // header keeps only its top padding, the title row leaves room for
        // the absolute close button (Lou's layout audit, s194)
        className="flex w-full flex-col gap-4 overflow-y-auto px-4 pb-6 sm:max-w-lg"
        data-testid="deal-drawer"
      >
        <SheetHeader className="px-0">
          <SheetTitle className="flex items-center gap-2 pe-8">
            <Input
              aria-label={t("deals.fields.title")}
              className="font-semibold"
              data-testid="deal-title"
              onBlur={() => {
                const next = title.trim()
                if (next && next !== deal.title) {
                  update.execute({ id, title: next })
                }
              }}
              onChange={(e) => setTitle(e.target.value)}
              value={title}
            />
            <Badge variant={deal.status === "won" ? "default" : "secondary"}>
              {t(`deals.statuses.${deal.status}`)}
            </Badge>
          </SheetTitle>
          <SheetDescription>
            {pipeline?.name} / {stageNames.get(deal.stageId) ?? deal.stageId}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-wrap gap-2">
          {deal.status === "open" ? (
            <>
              <Button
                data-testid="deal-won"
                disabled={busy}
                onClick={() => setStatus.execute({ id, status: "won" })}
                size="sm"
              >
                <TrophyIcon />
                {t("deals.markWon")}
              </Button>
              <Button
                data-testid="deal-lost"
                disabled={busy}
                onClick={() => setStatus.execute({ id, status: "lost" })}
                size="sm"
                variant="outline"
              >
                <ThumbsDownIcon />
                {t("deals.markLost")}
              </Button>
            </>
          ) : (
            <Button
              data-testid="deal-reopen"
              disabled={busy}
              onClick={() => setStatus.execute({ id, status: "open" })}
              size="sm"
              variant="outline"
            >
              <RotateCcwIcon />
              {t("deals.reopen")}
            </Button>
          )}
          <MovePipelineDialog
            deal={deal}
            disabled={busy}
            onMoved={(pipelineId) => {
              refresh()
              onPipelineMoved?.(pipelineId)
            }}
            ownerOptions={ownerOptions}
            workspaceId={workspaceId}
          />
          <ConfirmButton
            className="ml-auto"
            data-testid="deal-delete"
            description={t("deals.deleteConfirm")}
            disabled={busy}
            onConfirm={() => remove.execute({ ids: [id] })}
            size="sm"
            title={t("messages.deleteFeature", { feature: t("deals.one") })}
            variant="destructive"
          >
            <TrashIcon />
            {t("actions.delete")}
          </ConfirmButton>
        </div>

        <Tabs defaultValue="details">
          <TabsList>
            <TabsTrigger data-testid="deal-tab-details" value="details">
              {t("deals.tabs.details")}
            </TabsTrigger>
            <TabsTrigger data-testid="deal-tab-tasks" value="tasks">
              {t("deals.tabs.tasks")}
            </TabsTrigger>
            <TabsTrigger data-testid="deal-tab-comments" value="comments">
              {t("deals.tabs.comments")}
            </TabsTrigger>
            <TabsTrigger data-testid="deal-tab-activity" value="activity">
              {t("deals.tabs.activity")}
            </TabsTrigger>
          </TabsList>
          <TabsContent className="pt-3" value="details">
            <DealDetailsForm
              deal={deal}
              onMove={(stageId) => move.execute({ id, stageId })}
              onUpdate={(patch) => update.execute({ id, ...patch })}
              ownerOptions={ownerOptions}
              pipeline={pipeline}
              workspaceId={workspaceId}
            />
          </TabsContent>
          <TabsContent className="pt-3" value="tasks">
            <DealTasksPanel
              dealId={id}
              onChanged={refresh}
              ownerOptions={ownerOptions}
              workspaceId={workspaceId}
            />
          </TabsContent>
          <TabsContent className="pt-3" value="comments">
            <DealCommentsPanel
              dealId={id}
              onChanged={refresh}
              ownerOptions={ownerOptions}
              workspaceId={workspaceId}
            />
          </TabsContent>
          <TabsContent className="pt-3" value="activity">
            <DealActivityList
              activities={activities.data ?? []}
              adding={addNote.isPending}
              busy={busy}
              note={note}
              onAddNote={() => addNote.execute({ id, text: note })}
              onNoteChange={setNote}
              stageNames={stageNames}
            />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}
