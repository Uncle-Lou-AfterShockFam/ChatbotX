"use client"

import { InputField } from "@chatbotx.io/ui/components/form/input-field"
import { SelectField } from "@chatbotx.io/ui/components/form/select-field"
import { ListChecksIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useWatch } from "react-hook-form"
import { useOwnerOptions } from "@/features/deals/provider/deal-hook"
import { useWorkspaceId } from "@/hooks/routing"
import { BaseStepEditor } from "../base/editor"
import { PipelinePicker } from "../deal-pickers"

const CreateTaskStepEditor = ({ parentName }: { parentName: string }) => {
  const t = useTranslations()
  const workspaceId = useWorkspaceId()
  const assignTo = useWatch({ name: `${parentName}.assignTo` }) as string | undefined
  const ownerOptions = useOwnerOptions(workspaceId ?? "", {
    enabled: Boolean(workspaceId) && assignTo === "user",
  })
  return (
    <BaseStepEditor icon={ListChecksIcon} title={t("flows.actions.createTask")}>
      <div className="mt-3 space-y-3">
        <PipelinePicker parentName={parentName} />
        <InputField
          description={t("deals.tasks.stepTitleHint")}
          label={t("deals.fields.title")}
          name={`${parentName}.title`}
          placeholder="Call {{contact.full_name}}"
        />
        <InputField
          label={t("deals.tasks.description")}
          name={`${parentName}.description`}
        />
        <InputField
          description={t("deals.dueInDaysHint")}
          label={t("deals.dueInDays")}
          name={`${parentName}.dueInDays`}
          placeholder="2"
          type="number"
        />
        <SelectField
          label={t("deals.tasks.assignTo")}
          name={`${parentName}.assignTo`}
          options={[
            { label: t("deals.tasks.assignToOptions.none"), value: "none" },
            { label: t("deals.tasks.assignToOptions.dealOwner"), value: "dealOwner" },
            { label: t("deals.tasks.assignToOptions.user"), value: "user" },
          ]}
        />
        {assignTo === "user" ? (
          <SelectField
            label={t("deals.tasks.assignee")}
            name={`${parentName}.assigneeId`}
            options={ownerOptions}
          />
        ) : null}
      </div>
    </BaseStepEditor>
  )
}

export default CreateTaskStepEditor
