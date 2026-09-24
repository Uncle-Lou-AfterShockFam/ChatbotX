"use client"

import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import { DealDrawer } from "@/features/deals/deal-drawer"
import { namesById } from "@/features/deals/lib/names-by-id"
import { orpc } from "@/lib/orpc/query"
import { useInvalidateCrm, usePipelines } from "../provider/crm-hooks"

/**
 * The deal drawer opened from a contact or company page (s195): fetches the
 * deal and its pipeline itself so the caller only holds a deal id.
 */
export function CrmDealDrawer({
  workspaceId,
  dealId,
  onOpenChange,
}: {
  workspaceId: string
  dealId: string | null
  onOpenChange: (open: boolean) => void
}) {
  const pipelines = usePipelines(workspaceId)
  const deal = useQuery(
    orpc.dealsAPI.privateGetDealAPI.queryOptions({
      input: { workspaceId, id: dealId ?? "" },
      enabled: Boolean(dealId),
    }),
  )
  const invalidate = useInvalidateCrm()
  const pipeline =
    pipelines.data?.find((p) => p.id === deal.data?.pipelineId) ?? null
  // s196: a cross-pipeline move's old stages still read as names
  const stageNames = useMemo(
    () => namesById(pipelines.data ?? []),
    [pipelines.data],
  )
  return (
    <DealDrawer
      deal={dealId && deal.data ? deal.data : null}
      onChanged={() => {
        deal.refetch()
        invalidate()
      }}
      onOpenChange={onOpenChange}
      pipeline={pipeline}
      stageNames={stageNames}
      workspaceId={workspaceId}
    />
  )
}
