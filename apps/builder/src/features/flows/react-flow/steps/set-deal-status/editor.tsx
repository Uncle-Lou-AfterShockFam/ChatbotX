"use client"

import { SelectField } from "@chatbotx.io/ui/components/form/select-field"
import { TrophyIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { BaseStepEditor } from "../base/editor"
import { PipelinePicker } from "../deal-pickers"

const SetDealStatusStepEditor = ({ parentName }: { parentName: string }) => {
  const t = useTranslations()
  const statusOptions = [
    { label: t("deals.statuses.won"), value: "won" },
    { label: t("deals.statuses.lost"), value: "lost" },
  ]
  return (
    <BaseStepEditor icon={TrophyIcon} title={t("flows.actions.setDealStatus")}>
      <div className="mt-3 space-y-3">
        <PipelinePicker parentName={parentName} />
        <SelectField
          label={t("deals.fields.status")}
          name={`${parentName}.status`}
          options={statusOptions}
        />
      </div>
    </BaseStepEditor>
  )
}

export default SetDealStatusStepEditor
