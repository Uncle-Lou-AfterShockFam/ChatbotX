"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Kanban,
  KanbanCard,
  KanbanColumn,
  type KanbanMove,
  KanbanOverlay,
} from "@chatbotx.io/ui/components/ui/kanban"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import { SettingsIcon } from "lucide-react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { parseAsString, parseAsStringEnum, useQueryStates } from "nuqs"
import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import type { PipelineWithStagesResource } from "@/features/pipelines/schema/resource"
import { moveDealAction } from "./actions/move-deal-action"
import { applyMove } from "./board-helpers"
import { CreateDealDialog } from "./create-deal-dialog"
import { DealCardContent } from "./deal-card"
import { DealDrawer } from "./deal-drawer"
import { namesById } from "./lib/names-by-id"
import { PipelineSwitcher } from "./pipeline-switcher"
import {
  useDealBoard,
  useInvalidateDeals,
  useOwnerOptions,
} from "./provider/deal-hook"
import type { BoardStatusFilter } from "./schema/query"
import type { BoardColumnResource } from "./schema/resource"

export function DealsBoard({
  workspaceId,
  pipelines,
}: {
  workspaceId: string
  pipelines: PipelineWithStagesResource[]
}) {
  const t = useTranslations()
  const [
    { pipelineId: queryPipelineId, status, dealId: queryDealId },
    setQuery,
  ] = useQueryStates({
    pipelineId: parseAsString,
    // s194: a notification deep-links to `?pipelineId=&dealId=`
    dealId: parseAsString,
    status: parseAsStringEnum<BoardStatusFilter>([
      "open",
      "won",
      "lost",
      "all",
    ]).withDefault("open"),
  })
  const pipelineId =
    (queryPipelineId && pipelines.some((p) => p.id === queryPipelineId)
      ? queryPipelineId
      : pipelines[0]?.id) ?? null
  const pipeline = pipelines.find((p) => p.id === pipelineId) ?? null
  const allStageNames = useMemo(() => namesById(pipelines), [pipelines])

  const board = useDealBoard(workspaceId, pipelineId, status)
  const invalidate = useInvalidateDeals()
  const ownerOptions = useOwnerOptions(workspaceId)
  const ownerNames = useMemo(
    () => new Map(ownerOptions.map((o) => [o.value, o.label])),
    [ownerOptions],
  )

  // Local copy of the server board so a drop renders before the round trip.
  const [columns, setColumns] = useState<BoardColumnResource[]>([])
  useEffect(() => {
    if (board.data) {
      setColumns(board.data)
    }
  }, [board.data])

  const [openDealId, setOpenDealId] = useState<string | null>(queryDealId)
  const openDeal =
    columns.flatMap((c) => c.deals).find((d) => d.id === openDealId) ?? null
  // the query param opens the drawer once, then the local state owns it
  useEffect(() => {
    if (queryDealId) {
      setOpenDealId(queryDealId)
      setQuery({ dealId: null })
    }
  }, [queryDealId, setQuery])

  const { execute: move } = useAction(moveDealAction.bind(null, workspaceId), {
    onSuccess: () => invalidate(),
    onError: ({ error }) => {
      toast.error(error.serverError ?? t("deals.moveFailed"))
      // revert to the server's truth
      invalidate()
    },
  })

  const handleMove = useCallback(
    (kanbanMove: KanbanMove) => {
      const next = applyMove(columns, {
        cardId: String(kanbanMove.cardId),
        toColumnId: String(kanbanMove.toColumnId),
        index: kanbanMove.index,
      })
      if (!next) {
        return
      }
      setColumns(next.columns)
      move({
        id: String(kanbanMove.cardId),
        stageId: String(kanbanMove.toColumnId),
        position: next.position,
      })
    },
    [columns, move],
  )

  const kanbanColumns = useMemo(
    () =>
      Object.fromEntries(
        columns.map((c) => [c.stage.id, c.deals.map((d) => d.id)]),
      ),
    [columns],
  )

  if (pipelines.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <p className="text-muted-foreground">{t("deals.noPipelines")}</p>
        <Button
          render={<Link href={`/space/${workspaceId}/settings/pipelines`} />}
          size="sm"
        >
          <SettingsIcon />
          {t("deals.managePipelines")}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <PipelineSwitcher
          onChange={(id) => setQuery({ pipelineId: id })}
          pipelines={pipelines}
          value={pipelineId}
        />
        <Select
          items={(["open", "won", "lost", "all"] as const).map((value) => ({
            value,
            label:
              value === "all"
                ? t("deals.allStatuses")
                : t(`deals.statuses.${value}`),
          }))}
          onValueChange={(next) => {
            const status = String(next ?? "") as BoardStatusFilter
            if (status) {
              setQuery({ status })
            }
          }}
          value={status}
        >
          <SelectTrigger className="w-36" data-testid="deal-status-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["open", "won", "lost", "all"] as const).map((value) => (
              <SelectItem key={value} value={value}>
                {value === "all"
                  ? t("deals.allStatuses")
                  : t(`deals.statuses.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-2">
          <Button
            render={<Link href={`/space/${workspaceId}/settings/pipelines`} />}
            size="sm"
            variant="outline"
          >
            <SettingsIcon />
            {t("deals.managePipelines")}
          </Button>
          {pipeline ? (
            <CreateDealDialog
              defaultCurrency={pipeline.settings.defaultCurrency}
              fieldDefs={pipeline.settings.fieldDefs}
              onCreated={invalidate}
              pipelineId={pipeline.id}
              stages={pipeline.stages}
              workspaceId={workspaceId}
            />
          ) : null}
        </div>
      </div>

      <Kanban
        columns={kanbanColumns}
        onMove={handleMove}
        renderOverlay={(activeId) => {
          const deal = columns
            .flatMap((c) => c.deals)
            .find((d) => d.id === String(activeId))
          return deal ? (
            <KanbanOverlay>
              <DealCardContent
                deal={deal}
                ownerName={deal.ownerId ? ownerNames.get(deal.ownerId) : null}
              />
            </KanbanOverlay>
          ) : null
        }}
      >
        {columns.map((column) => (
          <KanbanColumn
            header={
              <div className="flex items-center justify-between gap-2">
                <span
                  className="flex items-center gap-2 font-medium text-sm"
                  data-testid={`stage-${column.stage.id}`}
                >
                  {column.stage.color ? (
                    <span
                      className="inline-block size-2.5 rounded-full"
                      style={{ backgroundColor: column.stage.color }}
                    />
                  ) : null}
                  {column.stage.name}
                </span>
                <span className="text-muted-foreground text-xs">
                  {column.deals.length}
                </span>
              </div>
            }
            id={column.stage.id}
            key={column.stage.id}
          >
            {column.deals.map((deal) => (
              <KanbanCard
                data-testid={`deal-${deal.id}`}
                id={deal.id}
                key={deal.id}
                onClick={() => setOpenDealId(deal.id)}
              >
                <DealCardContent
                  deal={deal}
                  ownerName={deal.ownerId ? ownerNames.get(deal.ownerId) : null}
                />
              </KanbanCard>
            ))}
          </KanbanColumn>
        ))}
      </Kanban>

      <DealDrawer
        deal={openDeal}
        onChanged={invalidate}
        onOpenChange={(open) => !open && setOpenDealId(null)}
        // s196: follow the deal to its new board (any status: it may land won)
        onPipelineMoved={(next) =>
          setQuery({ pipelineId: next, status: "all" })
        }
        pipeline={pipeline}
        stageNames={allStageNames}
        workspaceId={workspaceId}
      />
    </div>
  )
}
