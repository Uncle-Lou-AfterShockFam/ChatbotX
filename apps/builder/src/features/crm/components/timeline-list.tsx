"use client"

import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { useFormatter, useTranslations } from "next-intl"
import { describeActivity } from "@/features/deals/deal-drawer/activity-list"
import type { DealActivityResource } from "@/features/deals/schema/resource"
import type {
  CompanyActivityResource,
  TimelineKind,
  TimelinePageResource,
  TimelineRowResource,
} from "../schema/resource"
import { Spinner } from "./spinner"

type Translate = ReturnType<typeof useTranslations>

const ALL_KINDS: TimelineKind[] = [
  "companyActivity",
  "companyNote",
  "contactNote",
  "dealActivity",
  "submission",
  "appointment",
]

/** One line of copy for a company change-log row (shared by the timeline and the change-log card). */
export function describeCompanyActivity(
  activity: Pick<CompanyActivityResource, "type" | "payload">,
  t: Translate,
): string {
  const p = activity.payload as Record<string, unknown>
  const title = typeof p.title === "string" ? p.title : ""
  switch (activity.type) {
    case "created":
      return t("crm.activity.created", { name: String(p.name ?? "") })
    case "updated":
      return t("crm.activity.updated", {
        fields: Object.keys(
          (p.changed as Record<string, unknown> | undefined) ?? {},
        ).join(", "),
      })
    case "stopped":
      return t("crm.activity.stopped", { reason: String(p.reason ?? "") })
    case "noteAdded":
      return t("crm.activity.noteAdded", {
        excerpt: String(p.excerpt ?? ""),
      })
    case "noteDeleted":
      return t("crm.activity.noteDeleted")
    case "contactLinked":
      return t("crm.activity.contactLinked")
    case "contactUnlinked":
      return t("crm.activity.contactUnlinked")
    case "dealCreated":
      return t("crm.activity.dealCreated", { title })
    case "dealLinked":
      return t("crm.activity.dealLinked", { title })
    case "dealMoved":
      return t("crm.activity.dealMoved", { title })
    case "dealStatusChanged":
      return t("crm.activity.dealStatusChanged", {
        title,
        status: String(p.to ?? ""),
      })
    default:
      return activity.type
  }
}

function describeRow(
  row: TimelineRowResource,
  stageNames: Map<string, string>,
  t: Translate,
): { text: string; dealId?: string } {
  const p = row.payload as Record<string, unknown>
  switch (row.kind) {
    case "companyActivity":
      return {
        text: describeCompanyActivity(
          {
            type: p.type as CompanyActivityResource["type"],
            payload: (p.data as Record<string, unknown>) ?? {},
          },
          t,
        ),
      }
    case "companyNote":
    case "contactNote":
      return { text: String(p.text ?? "") }
    case "dealActivity": {
      const activity = {
        type: p.type,
        payload: (p.data as Record<string, unknown>) ?? {},
      } as DealActivityResource
      return {
        text: `${String(p.dealTitle ?? "")}: ${describeActivity(activity, stageNames, t)}`,
        dealId: typeof p.dealId === "string" ? p.dealId : undefined,
      }
    }
    case "submission":
      return {
        text: t("crm.timeline.submission", {
          name: String(p.questionnaireName ?? ""),
          status: String(p.status ?? ""),
        }),
      }
    case "appointment":
      return {
        text: t("crm.timeline.appointment", {
          name: String(p.calendarName ?? ""),
          status: String(p.status ?? ""),
        }),
      }
    default:
      return { text: row.kind }
  }
}

/**
 * The merged timeline of a contact or a company: kind chips filter, keyset
 * "load more" (the caller's infinite query owns the cursor chain; a chip
 * change is a new query key).
 */
export function TimelineList({
  pages,
  loading,
  hasMore,
  kinds,
  onKindsChange,
  onLoadMore,
  onOpenDeal,
  stageNames,
  availableKinds = ALL_KINDS,
}: {
  pages: TimelinePageResource[]
  loading: boolean
  hasMore: boolean
  kinds: TimelineKind[]
  onKindsChange: (kinds: TimelineKind[]) => void
  onLoadMore: () => void
  onOpenDeal?: (dealId: string) => void
  stageNames: Map<string, string>
  availableKinds?: TimelineKind[]
}) {
  const t = useTranslations()
  const format = useFormatter()
  const rows = pages.flatMap((page) => page.data)
  const toggle = (kind: TimelineKind) =>
    onKindsChange(
      kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind],
    )
  return (
    <div className="space-y-3" data-testid="crm-timeline">
      <div className="flex flex-wrap gap-1">
        {availableKinds.map((kind) => (
          <Button
            aria-pressed={kinds.includes(kind)}
            key={kind}
            onClick={() => toggle(kind)}
            size="sm"
            variant={kinds.includes(kind) ? "default" : "outline"}
          >
            {t(`crm.kinds.${kind}`)}
          </Button>
        ))}
      </div>
      {rows.length === 0 && !loading ? (
        <p className="text-muted-foreground text-sm">{t("crm.noTimeline")}</p>
      ) : (
        <ol className="divide-y">
          {rows.map((row) => {
            const d = describeRow(row, stageNames, t)
            return (
              <li
                className="flex items-start gap-3 py-2 text-sm"
                data-testid="crm-timeline-row"
                key={`${row.kind}:${row.id}`}
              >
                <Badge className="mt-0.5 shrink-0" variant="secondary">
                  {t(`crm.kinds.${row.kind}`)}
                </Badge>
                <div className="min-w-0 flex-1">
                  <RowText
                    dealId={d.dealId}
                    onOpenDeal={onOpenDeal}
                    text={d.text}
                  />
                </div>
                <span className="shrink-0 text-muted-foreground text-xs">
                  {format.dateTime(new Date(row.at), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </span>
              </li>
            )
          })}
        </ol>
      )}
      {loading ? <Spinner /> : null}
      {!loading && hasMore ? (
        <Button onClick={onLoadMore} size="sm" variant="outline">
          {t("crm.loadMore")}
        </Button>
      ) : null}
    </div>
  )
}

function RowText({
  text,
  dealId,
  onOpenDeal,
}: {
  text: string
  dealId?: string
  onOpenDeal?: (dealId: string) => void
}) {
  if (dealId && onOpenDeal) {
    return (
      <button
        className="text-start hover:underline"
        onClick={() => onOpenDeal(dealId)}
        type="button"
      >
        {text}
      </button>
    )
  }
  return <span className="whitespace-pre-wrap break-words">{text}</span>
}
