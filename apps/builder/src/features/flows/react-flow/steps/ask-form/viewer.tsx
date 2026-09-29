"use client"

import type { AskFormStepSchema } from "@chatbotx.io/flow-config"
import { Card, CardContent } from "@chatbotx.io/ui/components/ui/card"
import { ClipboardPenLineIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useForms } from "@/features/forms/provider/form-hooks"
import { useWorkspaceId } from "@/hooks/routing"
import { BaseStateViewer } from "../../states/viewer"
import { BaseStepViewer } from "../base/viewer"

export function AskFormStepViewer({ data }: { data: AskFormStepSchema }) {
  const t = useTranslations()
  const workspaceId = useWorkspaceId()
  const { data: forms = [] } = useForms(workspaceId)
  const title = forms.find((f) => f.id === data.formId)?.title
  return (
    <Card className="overflow-hidden p-0">
      <CardContent className="p-0">
        <div className="px-4 py-2">
          <BaseStepViewer
            icon={ClipboardPenLineIcon}
            title={t("flows.actions.askForm")}
          />
          <div className="mt-1 truncate text-muted-foreground text-xs">
            {title ?? t("flows.askForm.noFormPicked")}
          </div>
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
