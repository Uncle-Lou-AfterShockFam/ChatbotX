"use client"

import type { DealFieldDef } from "@chatbotx.io/database/partials"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import Link from "next/link"
import { useFormatter, useTranslations } from "next-intl"
import { useEffect, useState } from "react"
import type { PipelineWithStagesResource } from "@/features/pipelines/schema/resource"
import { formatDealValue } from "../deal-card"
import { DealCustomFieldsGrid, NONE } from "../deal-field-input"
import type { DealResource } from "../schema/resource"

/** `Date | null` -> the yyyy-mm-dd an <input type="date"> shows. */
export const toDateInput = (value: Date | null | undefined): string =>
  value ? value.toISOString().slice(0, 10) : ""

export type DealPatch = {
  value?: string | null
  priority?: DealResource["priority"]
  ownerId?: string | null
  dueAt?: Date | null
  fields?: Record<string, unknown>
}

/** Value / priority / stage / owner / due date grid, the custom fields, and the contact + company links. */
export function DealDetailsForm({
  workspaceId,
  deal,
  pipeline,
  ownerOptions,
  onUpdate,
  onMove,
}: {
  workspaceId: string
  deal: DealResource
  pipeline: PipelineWithStagesResource | null
  ownerOptions: { label: string; value: string }[]
  onUpdate: (patch: DealPatch) => void
  onMove: (stageId: string) => void
}) {
  const t = useTranslations()
  const format = useFormatter()
  const [value, setValue] = useState(deal.value ?? "")
  useEffect(() => {
    setValue(deal.value ?? "")
  }, [deal.value])
  const fieldDefs: DealFieldDef[] = pipeline?.settings.fieldDefs ?? []

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="space-y-1">
          <span className="text-muted-foreground text-xs">
            {t("deals.fields.value")}
          </span>
          <Input
            data-testid="deal-value"
            onBlur={() => {
              if (value !== (deal.value ?? "")) {
                onUpdate({ value: value === "" ? null : value })
              }
            }}
            onChange={(e) => setValue(e.target.value)}
            placeholder="0.00"
            value={value}
          />
          <span className="text-muted-foreground text-xs">
            {formatDealValue(deal.value, deal.currency, format) ?? "-"}
          </span>
        </div>
        <div className="space-y-1">
          <span className="text-muted-foreground text-xs">
            {t("deals.fields.priority")}
          </span>
          <Select
            onValueChange={(next) =>
              next &&
              next !== deal.priority &&
              onUpdate({ priority: next as DealResource["priority"] })
            }
            value={deal.priority}
          >
            <SelectTrigger data-testid="deal-priority">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["low", "medium", "high"] as const).map((p) => (
                <SelectItem key={p} value={p}>
                  {t(`deals.priorities.${p}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <span className="text-muted-foreground text-xs">
            {t("deals.stage")}
          </span>
          <Select
            onValueChange={(next) => {
              const stageId = String(next ?? "")
              if (stageId && stageId !== deal.stageId) {
                onMove(stageId)
              }
            }}
            value={deal.stageId}
          >
            <SelectTrigger data-testid="deal-stage">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(pipeline?.stages ?? []).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <span className="text-muted-foreground text-xs">
            {t("deals.fields.owner")}
          </span>
          <Select
            onValueChange={(next) => {
              const ownerId = String(next ?? "")
              onUpdate({ ownerId: ownerId === NONE ? null : ownerId })
            }}
            value={deal.ownerId ?? NONE}
          >
            <SelectTrigger data-testid="deal-owner">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t("deals.noOwner")}</SelectItem>
              {ownerOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <span className="text-muted-foreground text-xs">
            {t("deals.fields.dueAt")}
          </span>
          <Input
            aria-label={t("deals.fields.dueAt")}
            data-testid="deal-due-at"
            onChange={(e) => {
              const next = e.target.value
                ? new Date(`${e.target.value}T00:00:00Z`)
                : null
              if (toDateInput(next) !== toDateInput(deal.dueAt)) {
                onUpdate({ dueAt: next })
              }
            }}
            type="date"
            value={toDateInput(deal.dueAt)}
          />
        </div>
      </div>

      <DealCustomFieldsGrid
        fieldDefs={fieldDefs}
        onCommit={(key, next) => onUpdate({ fields: { [key]: next } })}
        testIdPrefix="deal-field"
        values={deal.fields}
      />

      <div className="space-y-1 text-sm">
        <div className="text-muted-foreground text-xs">
          {t("deals.fields.contact")}
        </div>
        {deal.contactId ? (
          // The hub has no per-contact route (contacts open inside the list
          // panel), so the link lands on the contacts list; the id is shown
          // so it can be searched for.
          <Link
            className="hover:underline"
            href={`/space/${workspaceId}/contacts`}
          >
            {t("deals.openContact")} ({deal.contactId})
          </Link>
        ) : (
          <span className="text-muted-foreground">{t("deals.noContact")}</span>
        )}
        {deal.companyId ? (
          <Link
            className="block hover:underline"
            href={`/space/${workspaceId}/companies/${deal.companyId}`}
          >
            {t("deals.openCompany")}
          </Link>
        ) : null}
      </div>
    </div>
  )
}
