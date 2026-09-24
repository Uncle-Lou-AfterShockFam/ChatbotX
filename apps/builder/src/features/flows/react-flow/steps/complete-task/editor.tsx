"use client"

import { InputField } from "@chatbotx.io/ui/components/form/input-field"
import { SelectField } from "@chatbotx.io/ui/components/form/select-field"
import { CheckCheckIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useWatch } from "react-hook-form"
import { BaseStepEditor } from "../base/editor"
import { PipelinePicker, TaskTemplatePicker } from "../deal-pickers"

const CompleteTaskStepEditor = ({ parentName }: { parentName: string }) => {
  const t = useTranslations()
  const match = useWatch({ name: `${parentName}.match` }) as string | undefined
  return (
    <BaseStepEditor icon={CheckCheckIcon} title={t("flows.actions.completeTask")}>
      <div className="mt-3 space-y-3">
        <PipelinePicker parentName={parentName} />
        <SelectField
          label={t("deals.tasks.matchBy")}
          name={`${parentName}.match`}
          options={[
            { label: t("deals.tasks.matchOptions.template"), value: "template" },
            { label: t("deals.tasks.matchOptions.title"), value: "title" },
          ]}
        />
        {match === "title" ? (
          <InputField
            description={t("deals.tasks.matchTitleHint")}
            label={t("deals.fields.title")}
            name={`${parentName}.title`}
          />
        ) : (
          <TaskTemplatePicker parentName={parentName} />
        )}
      </div>
    </BaseStepEditor>
  )
}

export default CompleteTaskStepEditor
