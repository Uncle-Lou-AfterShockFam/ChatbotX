"use client"

import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { CalendarIcon, UserIcon } from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import type { DealResource } from "./schema/resource"

export function formatDealValue(
  value: string | null,
  currency: string,
  format: ReturnType<typeof useFormatter>,
): string | null {
  if (value === null) {
    return null
  }
  const amount = Number(value)
  if (!Number.isFinite(amount)) {
    return `${value} ${currency}`
  }
  try {
    return format.number(amount, { style: "currency", currency })
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

const PRIORITY_VARIANT = {
  low: "secondary",
  medium: "outline",
  high: "destructive",
} as const

/** The card body; the board wraps it in a KanbanCard, the overlay in a KanbanOverlay. */
export function DealCardContent({
  deal,
  ownerName,
}: {
  deal: DealResource
  ownerName?: string | null
}) {
  const t = useTranslations()
  const format = useFormatter()
  const value = formatDealValue(deal.value, deal.currency, format)
  return (
    <div className="space-y-2" data-testid="deal-card">
      <div className="flex items-start justify-between gap-2">
        <span className="line-clamp-2 font-medium">{deal.title}</span>
        {deal.status === "open" ? null : (
          <Badge variant={deal.status === "won" ? "default" : "secondary"}>
            {t(`deals.statuses.${deal.status}`)}
          </Badge>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        {value ? (
          <span className="font-medium text-foreground">{value}</span>
        ) : null}
        <Badge variant={PRIORITY_VARIANT[deal.priority]}>
          {t(`deals.priorities.${deal.priority}`)}
        </Badge>
        {deal.dueAt ? (
          <span className="inline-flex items-center gap-1">
            <CalendarIcon className="size-3" />
            {format.dateTime(deal.dueAt, { dateStyle: "medium" })}
          </span>
        ) : null}
        {ownerName ? (
          <span className="inline-flex items-center gap-1">
            <UserIcon className="size-3" />
            {ownerName}
          </span>
        ) : null}
      </div>
    </div>
  )
}
