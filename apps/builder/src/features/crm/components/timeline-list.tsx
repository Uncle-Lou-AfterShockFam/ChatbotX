"use client"

import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Loader2Icon } from "lucide-react"
import Link from "next/link"
import { useFormatter, useTranslations } from "next-intl"
import { useState } from "react"
import { describeActivity } from "@/features/deals/deal-drawer/activity-list"
import type { DealActivityResource } from "@/features/deals/schema/resource"
import type {
  CompanyActivityResource,
  TimelineKind,
  TimelinePageResource,
  TimelineRowResource,
} from "../schema/resource"

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
      return p.linked
        ? t("crm.activity.dealLinked", { title })
        : t("crm.activity.dealCreated", { title })
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
): { text: string; href?: string; dealId?: string } {
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
 * "load more". `pages` is the list of fetched pages (the caller owns the
 * cursor chain so a chip change resets it).
 */
export function TimelineList({
  pages,
  loading,
  kinds,
  onKindsChange,
  onLoadMore,
  onOpenDeal,
  stageNames,
  availableKinds = ALL_KINDS,
}: {
  pages: TimelinePageResource[]
  loading: boolean
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
  const nextCursor = pages.at(-1)?.nextCursor ?? null
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
                    href={d.href}
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
      {loading ? (
        <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
      ) : null}
      {!loading && nextCursor ? (
        <Button onClick={onLoadMore} size="sm" variant="outline">
          {t("crm.loadMore")}
        </Button>
      ) : null}
    </div>
  )
}

function RowText({
  text,
  href,
  dealId,
  onOpenDeal,
}: {
  text: string
  href?: string
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
  if (href) {
    return (
      <Link className="hover:underline" href={href}>
        {text}
      </Link>
    )
  }
  return <span className="whitespace-pre-wrap break-words">{text}</span>
}

/** Cursor-chain state for a timeline: kinds reset the chain; `push` appends a page. */
export function useTimelinePages() {
  const [kinds, setKinds] = useState<TimelineKind[]>([])
  const [cursors, setCursors] = useState<(string | null)[]>([null])
  return {
    kinds,
    cursors,
    setKinds: (next: TimelineKind[]) => {
      setKinds(next)
      setCursors([null])
    },
    loadMore: (nextCursor: string | null) => {
      if (nextCursor && !cursors.includes(nextCursor)) {
        setCursors([...cursors, nextCursor])
      }
    },
  }
}
