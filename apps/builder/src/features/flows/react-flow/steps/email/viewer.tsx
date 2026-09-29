"use client"

import type { EmailStepSchema } from "@chatbotx.io/flow-config"
import { Card, CardContent } from "@chatbotx.io/ui/components/ui/card"
import { MailIcon } from "lucide-react"
import { useEmailTemplates } from "@/features/email-templates/provider/email-template-hooks"
import { useWorkspaceId } from "@/hooks/routing"
import { PageElementViewer } from "../../components/page-element-builder"

type EmailStepViewerProps = {
  data: EmailStepSchema
}

export default function EmailStepViewer(props: EmailStepViewerProps) {
  const { data } = props
  const workspaceId = useWorkspaceId()
  const templates = useEmailTemplates(workspaceId ?? "", true)
  const template = data.templateId
    ? templates.data?.find((t) => t.id === data.templateId)
    : undefined

  return (
    <Card className="overflow-hidden p-0">
      <CardContent className="p-0">
        <p className="bg-gray-200 px-4 py-1 font-bold dark:bg-neutral-600">
          {data.subject}
        </p>
        {data.templateId ? (
          <p
            className="flex items-center gap-2 px-4 py-2 text-sm"
            data-testid="email-step-template-name"
          >
            <MailIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {template?.name ?? `#${data.templateId}`}
            </span>
          </p>
        ) : null}
        {!data.templateId && data.elements.length > 0 && (
          <div className="flex flex-col gap-2 px-4 py-2">
            {data.elements.map((element) => (
              <PageElementViewer data={element} key={element.id} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
