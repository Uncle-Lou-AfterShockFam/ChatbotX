"use client"

import type { SendPageStepSchema } from "@chatbotx.io/flow-config"
import { Card, CardContent } from "@chatbotx.io/ui/components/ui/card"
import { FileTextIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { usePages } from "@/features/pages/provider/page-hooks"
import { useWorkspaceId } from "@/hooks/routing"
import { BaseStateViewer } from "../../states/viewer"
import { BaseStepViewer } from "../base/viewer"

const SendPageStepViewer = ({ data }: { data: SendPageStepSchema }) => {
  const t = useTranslations()
  const workspaceId = useWorkspaceId()
  const { data: pages } = usePages(workspaceId ?? "")
  const name = pages?.find((row) => row.id === data.pageId)?.name
  return (
    <Card className="overflow-hidden p-0">
      <CardContent className="p-0">
        <div className="flex flex-col gap-1 px-4 py-2">
          <BaseStepViewer
            icon={FileTextIcon}
            title={t("flows.actions.sendPage")}
          />
          <p className="truncate text-muted-foreground text-xs">
            {name ?? t("pages.step.noPagePicked")}
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

export default SendPageStepViewer
