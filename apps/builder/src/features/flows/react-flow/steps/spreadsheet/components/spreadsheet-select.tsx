"use client"

import { ComboboxField } from "@chatbotx.io/ui/components/form/combobox-field"
import { useQuery } from "@tanstack/react-query"
import { useTranslations } from "next-intl"
import { useWorkspaceId } from "@/hooks/routing"
import { client } from "@/lib/orpc/orpc"
import { orpc } from "@/lib/orpc/query"
import { fetchAllListPages } from "@/lib/query/fetch-all-list-pages"

type SpreadsheetSelectProps = {
  name: string
  label?: string
  required?: boolean
  triggerValueChange?: (value: string) => void
}

export const SpreadsheetSelect = ({
  name,
  label,
  required = true,
  triggerValueChange,
}: SpreadsheetSelectProps) => {
  const workspaceId = useWorkspaceId()
  const t = useTranslations()

  // Every page, not one call the server caps at 50 rows (s205).
  const { data } = useQuery({
    queryKey: orpc.spreadsheetsAPI.listSpreadsheetsAuthenticatedAPI.key({
      type: "query",
      input: { workspaceId },
    }),
    queryFn: ({ signal }) =>
      fetchAllListPages((page) =>
        client.spreadsheetsAPI.listSpreadsheetsAuthenticatedAPI(
          {
            workspaceId,
            ...page,
          },
          { signal },
        ),
      ),
  })
  const options = (data ?? []).map((spreadsheet) => ({
    label: spreadsheet.name,
    value: spreadsheet.id,
  }))

  return (
    <ComboboxField
      emptyText={t("actions.noRecordFound")}
      label={label ?? t("fields.spreadsheets.label")}
      name={name}
      options={options}
      placeholder={t("actions.pleaseSelect")}
      popoverClassName="w-[var(--dice-anchor-width)]"
      required={required}
      triggerValueChange={triggerValueChange}
    />
  )
}
