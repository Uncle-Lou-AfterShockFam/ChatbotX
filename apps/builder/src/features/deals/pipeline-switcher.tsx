"use client"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import { useTranslations } from "next-intl"

export function PipelineSwitcher({
  pipelines,
  value,
  onChange,
}: {
  pipelines: { id: string; name: string }[]
  value: string | null
  onChange: (pipelineId: string) => void
}) {
  const t = useTranslations()
  return (
    <Select
      onValueChange={(next) => {
        const id = String(next ?? "")
        if (id) {
          onChange(id)
        }
      }}
      value={value ?? ""}
    >
      <SelectTrigger className="w-56" data-testid="pipeline-switcher">
        <SelectValue placeholder={t("deals.pipeline")} />
      </SelectTrigger>
      <SelectContent>
        {pipelines.map((pipeline) => (
          <SelectItem key={pipeline.id} value={pipeline.id}>
            {pipeline.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
