"use client"

import type { SendDocumentForSignatureStepSchema } from "@chatbotx.io/flow-config"
import { Card, CardContent } from "@chatbotx.io/ui/components/ui/card"
import { FileSignatureIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useDocumentTemplates } from "@/features/documents/provider/document-hooks"
import { useWorkspaceId } from "@/hooks/routing"
import { BaseStateViewer } from "../../states/viewer"
import { BaseStepViewer } from "../base/viewer"

const SendDocumentForSignatureStepViewer = ({
  data,
}: {
  data: SendDocumentForSignatureStepSchema
}) => {
  const t = useTranslations()
  const workspaceId = useWorkspaceId()
  const { data: templates } = useDocumentTemplates(workspaceId ?? "")
  const name = templates?.find((row) => row.id === data.templateId)?.name
  return (
    <Card className="overflow-hidden p-0">
      <CardContent className="p-0">
        <div className="flex flex-col gap-1 px-4 py-2">
          <BaseStepViewer
            icon={FileSignatureIcon}
            title={t("flows.actions.sendDocumentForSignature")}
          />
          <p className="truncate text-muted-foreground text-xs">
            {name ?? t("documents.signStep.noTemplatePicked")}
          </p>
        </div>
        {/* React Flow keeps each state's connector on physical Position.Right. */}
        <div className="my-2 mr-3 flex flex-col gap-1">
          {data.states.map((state) => (
            <BaseStateViewer data={state} key={state.id} />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

export default SendDocumentForSignatureStepViewer
