"use client"

import type { BulktextSendStepSchema } from "@chatbotx.io/flow-config"
import { Card, CardContent } from "@chatbotx.io/ui/components/ui/card"
import { useTranslations } from "next-intl"
import { useBotFieldTokenLabels } from "@/components/tiptap/use-bot-field-token-labels"

type BulktextSendStepViewerProps = {
  data: BulktextSendStepSchema
}

const BulktextSendStepViewer = ({ data }: BulktextSendStepViewerProps) => {
  const t = useTranslations()
  const previewText = useBotFieldTokenLabels(data.text)
  const options = [
    data.dryRun ? t("fields.bulktextDryRun.label") : null,
    data.scheduleAt
      ? `${t("fields.bulktextScheduleAt.label")}: ${data.scheduleAt}`
      : null,
    data.spreadOverMinutes > 0
      ? `${t("fields.bulktextSpreadOverMinutes.label")}: ${data.spreadOverMinutes}`
      : null,
    data.skipIfRepliedSince
      ? `${t("fields.bulktextSkipIfRepliedSince.label")}: ${data.skipIfRepliedSince}`
      : null,
  ].filter((entry): entry is string => entry !== null)

  return (
    <Card className="overflow-hidden p-0">
      <CardContent className="p-0">
        <p className="bg-gray-200 px-4 py-1 font-medium text-xs dark:bg-neutral-700">
          {t("flows.actions.bulktextSend")}
        </p>
        {data.text !== "" && (
          <p className="whitespace-pre-line bg-gray-200 px-4 py-2 dark:bg-neutral-600">
            {previewText}
          </p>
        )}
        {data.photoUrl !== "" && (
          <p className="truncate bg-gray-200 px-4 py-1 text-xs dark:bg-neutral-600">
            {data.photoUrl}
          </p>
        )}
        {options.length > 0 && (
          <p className="px-4 py-1 text-muted-foreground text-xs">
            {options.join(" · ")}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

export default BulktextSendStepViewer
