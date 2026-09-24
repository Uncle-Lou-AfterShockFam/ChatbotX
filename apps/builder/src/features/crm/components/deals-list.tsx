"use client"

import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { useFormatter, useTranslations } from "next-intl"
import { isOverdue } from "@/features/deals/deal-card"
import type { DealResource } from "@/features/deals/schema/resource"
import type { PipelineWithStagesResource } from "@/features/pipelines/schema/resource"

const STATUS_VARIANT = {
  open: "outline",
  won: "default",
  lost: "destructive",
} as const

/** Deal rows of a contact or company; a click hands the deal to the caller's drawer. */
export function DealsList({
  deals,
  pipelines,
  onOpen,
}: {
  deals: DealResource[]
  pipelines: PipelineWithStagesResource[]
  onOpen: (deal: DealResource) => void
}) {
  const t = useTranslations()
  const format = useFormatter()
  if (deals.length === 0) {
    return <p className="text-muted-foreground text-sm">{t("crm.noDeals")}</p>
  }
  const stageName = (deal: DealResource) =>
    pipelines
      .find((p) => p.id === deal.pipelineId)
      ?.stages.find((s) => s.id === deal.stageId)?.name ?? ""
  const pipelineName = (deal: DealResource) =>
    pipelines.find((p) => p.id === deal.pipelineId)?.name ?? ""
  return (
    <ul className="divide-y" data-testid="crm-deals">
      {deals.map((deal) => (
        <li key={deal.id}>
          <button
            className="flex w-full items-center justify-between gap-3 py-2 text-start text-sm hover:bg-muted/50"
            data-testid="crm-deal-row"
            onClick={() => onOpen(deal)}
            type="button"
          >
            <div className="min-w-0">
              <div className="truncate font-medium">{deal.title}</div>
              <div className="truncate text-muted-foreground text-xs">
                {[pipelineName(deal), stageName(deal)]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {deal.value ? (
                <span className="text-xs">
                  {format.number(Number(deal.value), {
                    style: "currency",
                    currency: deal.currency,
                  })}
                </span>
              ) : null}
              {isOverdue(deal) ? (
                <Badge variant="destructive">{t("deals.overdue")}</Badge>
              ) : null}
              <Badge variant={STATUS_VARIANT[deal.status]}>
                {t(`deals.statuses.${deal.status}`)}
              </Badge>
            </div>
          </button>
        </li>
      ))}
    </ul>
  )
}
