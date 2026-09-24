"use client"

import { InputField } from "@chatbotx.io/ui/components/form/input-field"
import { SelectField } from "@chatbotx.io/ui/components/form/select-field"
import { SwitchField } from "@chatbotx.io/ui/components/form/switch-field"
import { HandshakeIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useOwnerOptions } from "@/features/deals/provider/deal-hook"
import { useWorkspaceId } from "@/hooks/routing"
import { BaseStepEditor } from "../base/editor"
import { PipelinePicker, StagePicker } from "../deal-pickers"

const CreateDealStepEditor = ({ parentName }: { parentName: string }) => {
  const t = useTranslations()
  const workspaceId = useWorkspaceId()
  const ownerOptions = useOwnerOptions(workspaceId ?? "", {
    enabled: Boolean(workspaceId),
  })
  const priorityOptions = [
    { label: t("deals.priorities.low"), value: "low" },
    { label: t("deals.priorities.medium"), value: "medium" },
    { label: t("deals.priorities.high"), value: "high" },
  ]

  return (
    <BaseStepEditor icon={HandshakeIcon} title={t("flows.actions.createDeal")}>
      <div className="mt-3 space-y-3">
        <PipelinePicker parentName={parentName} />
        <StagePicker
          allowClear
          clearLabel={t("deals.firstStage")}
          parentName={parentName}
        />
        <InputField
          description={t("deals.titleHint")}
          label={t("deals.fields.title")}
          name={`${parentName}.title`}
          placeholder="Deal for {{contact.full_name}}"
        />
        <InputField
          description={t("deals.valueHint")}
          label={t("deals.fields.value")}
          name={`${parentName}.value`}
          placeholder="1500"
        />
        <InputField
          label={t("deals.fields.currency")}
          name={`${parentName}.currency`}
          placeholder="USD"
        />
        <SelectField
          label={t("deals.fields.priority")}
          name={`${parentName}.priority`}
          options={priorityOptions}
        />
        <SelectField
          allowClear
          clearLabel={t("deals.noOwner")}
          label={t("deals.fields.owner")}
          name={`${parentName}.ownerId`}
          options={ownerOptions}
        />
        <InputField
          description={t("deals.dueInDaysHint")}
          label={t("deals.dueInDays")}
          name={`${parentName}.dueInDays`}
          placeholder="7"
          type="number"
        />
        <SwitchField
          description={t("deals.skipIfOpenDealExistsHint")}
          label={t("deals.skipIfOpenDealExists")}
          name={`${parentName}.skipIfOpenDealExists`}
        />
      </div>
    </BaseStepEditor>
  )
}

export default CreateDealStepEditor
