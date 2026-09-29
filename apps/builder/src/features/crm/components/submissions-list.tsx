"use client"

import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import Link from "next/link"
import { useFormatter, useTranslations } from "next-intl"
import type { SubmissionSummaryResource } from "../schema/resource"

/** Form submissions (web or chat); each row opens the form's submissions page (the answers live there). */
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
              href={`/space/${workspaceId}/forms/${s.formId}/submissions`}
            >
              {s.formTitle}
            </Link>
            <div className="text-muted-foreground text-xs">
              {format.dateTime(new Date(s.createdAt), {
                dateStyle: "medium",
                timeStyle: "short",
              })}
              {s.score === null
                ? ""
                : ` · ${t("crm.points", { points: s.score })}`}
            </div>
          </div>
          <Badge variant="outline">
            {t(s.channel === "chat" ? "crm.channel.chat" : "crm.channel.web")}
          </Badge>
        </li>
      ))}
    </ul>
  )
}
