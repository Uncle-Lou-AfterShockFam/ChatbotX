"use client"

import { ComboboxField } from "@chatbotx.io/ui/components/form/combobox-field"
import { InputNumberField } from "@chatbotx.io/ui/components/form/input-number-field"
import { FileTextIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useMemo } from "react"
import { usePages } from "@/features/pages/provider/page-hooks"
import { useWorkspaceId } from "@/hooks/routing"
import { BaseStepEditor } from "../base/editor"

const SendPageStepEditor = ({ parentName }: { parentName: string }) => {
  const t = useTranslations()
  const workspaceId = useWorkspaceId()
  const { data: pages } = usePages(workspaceId ?? "")
  const options = useMemo(
    () => (pages ?? []).map((page) => ({ label: page.name, value: page.id })),
    [pages],
  )
  return (
    <BaseStepEditor icon={FileTextIcon} title={t("flows.actions.sendPage")}>
      <div className="mt-3 space-y-3">
        <ComboboxField
          description={t("pages.step.hint")}
          emptyText={t("pages.step.noPages")}
          label={t("pages.step.page")}
          name={`${parentName}.pageId`}
          options={options}
          placeholder={t("actions.pleaseSelect")}
          popoverClassName="w-[var(--anchor-width)]"
        />
        <InputNumberField
          description={t("pages.step.ttlHint")}
          label={t("pages.step.ttl")}
          max={2160}
          min={1}
          name={`${parentName}.ttlHours`}
          stepper={1}
        />
      </div>
    </BaseStepEditor>
  )
}

export default SendPageStepEditor
