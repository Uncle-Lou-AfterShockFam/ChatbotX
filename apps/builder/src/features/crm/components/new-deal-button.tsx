"use client"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { CreateDealDialog } from "@/features/deals/create-deal-dialog"
import { useInvalidateCrm, usePipelines } from "../provider/crm-hooks"

/** Pipeline picker + the create-deal dialog with the contact / company preset (s195). */
export function NewDealButton({
  workspaceId,
  presetContact,
  presetCompanyId,
}: {
  workspaceId: string
  presetContact?: { id: string; label: string } | null
  presetCompanyId?: string | null
}) {
  const t = useTranslations()
  const pipelines = usePipelines(workspaceId)
  const invalidate = useInvalidateCrm()
  const [pipelineId, setPipelineId] = useState<string | null>(null)
  const list = pipelines.data ?? []
  const pipeline = list.find((p) => p.id === pipelineId) ?? list[0] ?? null
  if (!pipeline) {
    return null
  }
  // base-ui renders the raw value unless the root gets `items` (s194 trap)
  const items = list.map((p) => ({ value: p.id, label: p.name }))
  return (
    <div className="flex items-center gap-2">
      {list.length > 1 ? (
        <Select
          items={items}
          onValueChange={(value) =>
            setPipelineId(typeof value === "string" ? value : null)
          }
          value={pipeline.id}
        >
          <SelectTrigger aria-label={t("deals.pipeline")} className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <CreateDealDialog
        defaultCurrency={pipeline.settings.defaultCurrency}
        fieldDefs={pipeline.settings.fieldDefs}
        onCreated={invalidate}
        pipelineId={pipeline.id}
        presetCompanyId={presetCompanyId}
        presetContact={presetContact}
        stages={pipeline.stages}
        workspaceId={workspaceId}
      />
    </div>
  )
}
