"use client"

import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import {
  CalendarIcon,
  ListTodoIcon,
  MessageSquareIcon,
  UserIcon,
} from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import type { BoardDealResource, DealResource } from "./schema/resource"

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

/** Open and past its due date (a closed deal is never overdue). */
export function isOverdue(
  deal: { status: string; dueAt: Date | null },
  now: Date = new Date(),
): boolean {
  return deal.status === "open" && deal.dueAt !== null && deal.dueAt < now
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
  deal: DealResource & Partial<DealCardCounts>
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
          <span
            className={
              isOverdue(deal)
                ? "inline-flex items-center gap-1 font-medium text-destructive"
                : "inline-flex items-center gap-1"
            }
            data-testid={isOverdue(deal) ? "deal-overdue" : "deal-due"}
            title={isOverdue(deal) ? t("deals.overdue") : undefined}
          >
            <CalendarIcon className="size-3" />
            {format.dateTime(deal.dueAt, {
              dateStyle: "medium",
              timeZone: "UTC",
            })}
          </span>
        ) : null}
        {ownerName ? (
          <span className="inline-flex items-center gap-1">
            <UserIcon className="size-3" />
            {ownerName}
          </span>
        ) : null}
        <DealCountChips deal={deal} />
      </div>
    </div>
  )
}

type DealCardCounts = Pick<
  BoardDealResource,
  "openTaskCount" | "overdueTaskCount" | "commentCount"
>

/** Open tasks (red when any is overdue) and comments; a zero count shows nothing (s198). */
function DealCountChips({ deal }: { deal: Partial<DealCardCounts> }) {
  const t = useTranslations()
  const open = deal.openTaskCount ?? 0
  const overdue = deal.overdueTaskCount ?? 0
  const comments = deal.commentCount ?? 0
  const tasksLabel =
    overdue > 0
      ? t("deals.card.tasksOverdue", { count: open, overdue })
      : t("deals.card.tasks", { count: open })
  const commentsLabel = t("deals.card.comments", { count: comments })
  return (
    <>
      {open > 0 ? (
        <span
          className={
            overdue > 0
              ? "inline-flex items-center gap-1 font-medium text-destructive"
              : "inline-flex items-center gap-1"
          }
          data-testid={overdue > 0 ? "deal-tasks-overdue" : "deal-tasks"}
          title={tasksLabel}
        >
          <ListTodoIcon aria-hidden className="size-3" />
          <span aria-hidden>{open}</span>
          <span className="sr-only">{tasksLabel}</span>
        </span>
      ) : null}
      {comments > 0 ? (
        <span
          className="inline-flex items-center gap-1"
          data-testid="deal-comments"
          title={commentsLabel}
        >
          <MessageSquareIcon aria-hidden className="size-3" />
          <span aria-hidden>{comments}</span>
          <span className="sr-only">{commentsLabel}</span>
        </span>
      ) : null}
    </>
  )
}
