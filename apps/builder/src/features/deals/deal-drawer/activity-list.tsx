"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Textarea } from "@chatbotx.io/ui/components/ui/textarea"
import { Loader2Icon } from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import type { DealActivityResource } from "../schema/resource"

type Translate = ReturnType<typeof useTranslations>

const text = (value: unknown, fallback = "") =>
  value === null || value === undefined ? fallback : String(value)

/** One human line per activity row; unknown types fall back to the type name. */
export function describeActivity(
  activity: DealActivityResource,
  stageNames: Map<string, string>,
  t: Translate,
): string {
  const p = activity.payload as Record<string, unknown>
  switch (activity.type) {
    case "created":
      return t("deals.activity.created", {
        stage: stageNames.get(String(p.stageId)) ?? text(p.stageId),
      })
    case "stageMoved":
      return t("deals.activity.stageMoved", {
        from: stageNames.get(String(p.from)) ?? text(p.from),
        to: stageNames.get(String(p.to)) ?? text(p.to),
      })
    // s196: `stageNames` is `namesById`, so the pipeline ids resolve too
    case "pipelineMoved":
      return t("deals.activity.pipelineMoved", {
        fromPipeline:
          stageNames.get(String(p.fromPipelineId)) ?? text(p.fromPipelineId),
        toPipeline:
          stageNames.get(String(p.toPipelineId)) ?? text(p.toPipelineId),
        to: stageNames.get(String(p.to)) ?? text(p.to),
      })
    case "valueChanged":
      return t("deals.activity.valueChanged", {
        from: text(p.from, "-"),
        to: text(p.to, "-"),
      })
    case "statusChanged":
    case "priorityChanged":
    case "titleChanged":
    case "currencyChanged":
      return t(`deals.activity.${activity.type}`, {
        from: text(p.from),
        to: text(p.to),
      })
    case "dueAtChanged":
      return t("deals.activity.dueAtChanged", {
        from: text(p.from, "-").slice(0, 10),
        to: text(p.to, "-").slice(0, 10),
      })
    case "fieldChanged":
      return t("deals.activity.fieldChanged", {
        key: text(p.key),
        from:
          p.from === null || p.from === undefined
            ? "-"
            : JSON.stringify(p.from),
        to: p.to === null || p.to === undefined ? "-" : JSON.stringify(p.to),
      })
    case "taskCreated":
    case "taskCompleted":
      return t(`deals.activity.${activity.type}`, { title: text(p.title) })
    case "commented":
      return t("deals.activity.commented", {
        excerpt: text(p.excerpt),
        count: Array.isArray(p.mentionedUserIds)
          ? p.mentionedUserIds.length
          : 0,
      })
    case "assigned":
      return t("deals.activity.assigned")
    // s195: re-linked after creation (the names live on the drawer's links section)
    case "contactChanged":
      return t("deals.activity.contactChanged")
    case "companyChanged":
      return t("deals.activity.companyChanged")
    case "note":
      return text(p.text)
    default:
      return activity.type
  }
}

export function DealActivityList({
  activities,
  stageNames,
  note,
  onNoteChange,
  onAddNote,
  adding,
  busy,
}: {
  activities: DealActivityResource[]
  stageNames: Map<string, string>
  note: string
  onNoteChange: (note: string) => void
  onAddNote: () => void
  adding: boolean
  busy: boolean
}) {
  const t = useTranslations()
  const format = useFormatter()
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Textarea
          data-testid="deal-note"
          onChange={(e) => onNoteChange(e.target.value)}
          placeholder={t("deals.notePlaceholder")}
          rows={2}
          value={note}
        />
        <Button
          disabled={busy || note.trim().length === 0}
          onClick={onAddNote}
          size="sm"
        >
          {adding ? <Loader2Icon className="animate-spin" /> : null}
          {t("deals.addNote")}
        </Button>
      </div>
      <ul className="space-y-2 text-sm" data-testid="deal-activities">
        {activities.map((activity) => (
          <li className="rounded-md border p-2" key={activity.id}>
            <div className="text-muted-foreground text-xs">
              {format.dateTime(activity.createdAt, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
              {" · "}
              {t(`deals.activity.types.${activity.type}`)}
            </div>
            <div className="whitespace-pre-wrap">
              {describeActivity(activity, stageNames, t)}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
