"use client"

import {
  type InvoiceStatus,
  invoiceStatuses,
} from "@chatbotx.io/database/partials"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@chatbotx.io/ui/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { InvoiceList } from "./components/invoice-list"

const ALL = "all"

/** Workspace > Invoices: every hub invoice, filterable by status. */
export function InvoicesPage({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations()
  const [status, setStatus] = useState<InvoiceStatus | typeof ALL>(ALL)
  const options = [
    { value: ALL, label: t("invoices.allStatuses") },
    ...invoiceStatuses.options.map((value) => ({
      value,
      label: t(`invoices.status.${value}`),
    })),
  ]
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="font-bold text-xl">
          {t("invoices.title")}
        </CardTitle>
        <Select
          items={options}
          onValueChange={(value) =>
            setStatus((value as InvoiceStatus | typeof ALL | null) ?? ALL)
          }
          value={status}
        >
          <SelectTrigger
            aria-label={t("invoices.fields.status")}
            className="w-48 max-w-full"
            data-testid="invoices-status-filter"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-muted-foreground text-sm">
          {t("invoices.pageHint")}
        </p>
        <InvoiceList
          status={status === ALL ? undefined : status}
          workspaceId={workspaceId}
        />
      </CardContent>
    </Card>
  )
}
