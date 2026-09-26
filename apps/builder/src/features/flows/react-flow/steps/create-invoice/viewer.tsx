"use client"

import type { CreateInvoiceStepSchema } from "@chatbotx.io/flow-config"
import { Card, CardContent } from "@chatbotx.io/ui/components/ui/card"
import { ReceiptTextIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { BaseStateViewer } from "../../states/viewer"
import { BaseStepViewer } from "../base/viewer"

const CreateInvoiceStepViewer = ({
  data,
}: {
  data: CreateInvoiceStepSchema
}) => {
  const t = useTranslations()
  const first = data.lines[0]
  const summary = first
    ? t("invoices.step.summary", {
        count: data.lines.length,
        description: first.description || "…",
        currency: data.currency,
      })
    : t("invoices.step.noLines")
  return (
    <Card className="overflow-hidden p-0">
      <CardContent className="p-0">
        <div className="flex flex-col gap-1 px-4 py-2">
          <BaseStepViewer
            icon={ReceiptTextIcon}
            title={t("flows.actions.createInvoice")}
          />
          <p className="truncate text-muted-foreground text-xs">{summary}</p>
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

export default CreateInvoiceStepViewer
