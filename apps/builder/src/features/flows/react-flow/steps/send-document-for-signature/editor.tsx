"use client"

import { ComboboxField } from "@chatbotx.io/ui/components/form/combobox-field"
import { FileSignatureIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useMemo } from "react"
import { useDocumentTemplates } from "@/features/documents/provider/document-hooks"
import { useWorkspaceId } from "@/hooks/routing"
import { BaseStepEditor } from "../base/editor"

const SendDocumentForSignatureStepEditor = ({
  parentName,
}: {
  parentName: string
}) => {
  const t = useTranslations()
  const workspaceId = useWorkspaceId()
  const { data: templates } = useDocumentTemplates(workspaceId ?? "")
  const options = useMemo(
    () =>
      (templates ?? []).map((template) => ({
        label: template.name,
        value: template.id,
      })),
    [templates],
  )
  return (
    <BaseStepEditor
      icon={FileSignatureIcon}
      title={t("flows.actions.sendDocumentForSignature")}
    >
      <div className="mt-3 space-y-3">
        <ComboboxField
          description={t("documents.signStep.hint")}
          emptyText={t("documents.signStep.noTemplates")}
          label={t("documents.signStep.template")}
          name={`${parentName}.templateId`}
          options={options}
          placeholder={t("actions.pleaseSelect")}
          popoverClassName="w-[var(--anchor-width)]"
        />
      </div>
    </BaseStepEditor>
  )
}

export default SendDocumentForSignatureStepEditor
