"use client"

import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import Link from "next/link"
import { useFormatter, useTranslations } from "next-intl"
import type { SubmissionSummaryResource } from "../schema/resource"

/** Questionnaire submissions; each row opens the questionnaire's applicants page (the answers live there). */
export function SubmissionsList({
  workspaceId,
  submissions,
}: {
  workspaceId: string
  submissions: SubmissionSummaryResource[]
}) {
  const t = useTranslations()
  const format = useFormatter()
  if (submissions.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">{t("crm.noSubmissions")}</p>
    )
  }
  return (
    <ul className="divide-y" data-testid="crm-submissions">
      {submissions.map((s) => (
        <li
          className="flex items-center justify-between gap-3 py-2 text-sm"
          key={s.id}
        >
          <div className="min-w-0">
            <Link
              className="truncate font-medium hover:underline"
              href={`/space/${workspaceId}/questionnaires/${s.questionnaireId}/applicants`}
            >
              {s.questionnaireName}
            </Link>
            <div className="text-muted-foreground text-xs">
              {format.dateTime(new Date(s.completedAt ?? s.createdAt), {
                dateStyle: "medium",
                timeStyle: "short",
              })}
              {s.totalPoints === null
                ? ""
                : ` · ${t("crm.points", { points: s.totalPoints })}`}
            </div>
          </div>
          <Badge variant={s.status === "completed" ? "default" : "outline"}>
            {s.status}
          </Badge>
        </li>
      ))}
    </ul>
  )
}
