"use client"

import { InputField } from "@chatbotx.io/ui/components/form/input-field"
import { InputNumberField } from "@chatbotx.io/ui/components/form/input-number-field"
import { SwitchField } from "@chatbotx.io/ui/components/form/switch-field"
import { useTranslations } from "next-intl"
import { TiptapEditorField } from "@/components/tiptap/tiptap-editor-field"

type BulktextSendStepEditorProps = {
  parentName: string
}

const BulktextSendStepEditor = ({
  parentName,
}: BulktextSendStepEditorProps) => {
  const t = useTranslations()

  return (
    <div className="items-center justify-center overflow-hidden rounded-lg">
      <div className="bg-secondary px-4 py-2">
        <TiptapEditorField
          includeBotFieldVariables
          includeCouponVariables
          name={`${parentName}.text`}
        />
      </div>
      <div className="space-y-3 bg-slate-200 px-3 py-3 dark:bg-neutral-900">
        <InputField
          label={t("fields.bulktextPhotoUrl.label")}
          name={`${parentName}.photoUrl`}
          placeholder={t("fields.bulktextPhotoUrl.placeholder")}
        />
        <SwitchField
          description={t("fields.bulktextDryRun.description")}
          label={t("fields.bulktextDryRun.label")}
          name={`${parentName}.dryRun`}
        />
        <InputField
          label={t("fields.bulktextRef.label")}
          name={`${parentName}.ref`}
          placeholder={t("fields.bulktextRef.placeholder")}
        />
        <InputField
          description={t("fields.bulktextScheduleAt.description")}
          label={t("fields.bulktextScheduleAt.label")}
          name={`${parentName}.scheduleAt`}
          placeholder="2026-09-21T15:00:00Z"
        />
        <InputNumberField
          description={t("fields.bulktextSpreadOverMinutes.description")}
          label={t("fields.bulktextSpreadOverMinutes.label")}
          name={`${parentName}.spreadOverMinutes`}
        />
        <InputField
          description={t("fields.bulktextSkipIfRepliedSince.description")}
          label={t("fields.bulktextSkipIfRepliedSince.label")}
          name={`${parentName}.skipIfRepliedSince`}
          placeholder="2026-09-20T00:00:00Z"
        />
      </div>
    </div>
  )
}

export default BulktextSendStepEditor
