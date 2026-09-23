"use client"

import { DataTable } from "@chatbotx.io/ui/components/data-table/data-table"
import { DataTableToolbar } from "@chatbotx.io/ui/components/data-table/data-table-toolbar"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@chatbotx.io/ui/components/ui/card"
import { useDataTable } from "@chatbotx.io/ui/hooks/use-data-table"
import type { DataTableRowAction } from "@chatbotx.io/ui/types/data-table"
import { useTranslations } from "next-intl"
import React, { useMemo } from "react"
import { getCompanyColumns } from "./companies-table-columns"
import { CreateCompanyDialog } from "./create-company-dialog"
import { DeleteCompaniesDialog } from "./delete-company-dialog"
import type { listCompaniesRSC } from "./queries"
import type { CompanyWithContactCountResource } from "./schema/resource"
import { StopCompanyDialog } from "./stop-company-dialog"
import { UpdateCompanyDialog } from "./update-company-dialog"

type CompaniesTableProps = {
  promises: Promise<[Awaited<ReturnType<typeof listCompaniesRSC>>]>
  workspaceId: string
}

export function CompaniesTable({ promises, workspaceId }: CompaniesTableProps) {
  const [{ data, pageCount }] = React.use(promises)
  const [rowAction, setRowAction] =
    React.useState<DataTableRowAction<CompanyWithContactCountResource> | null>(
      null,
    )
  const [stopTarget, setStopTarget] =
    React.useState<CompanyWithContactCountResource | null>(null)
  const t = useTranslations()

  // biome-ignore lint/correctness/useExhaustiveDependencies: we need to memoize the columns
  const columns = useMemo(
    () =>
      getCompanyColumns({
        workspaceId,
        setRowAction,
        onStop: setStopTarget,
        t,
      }),
    [],
  )

  const { table } = useDataTable({
    data,
    columns,
    pageCount,
    initialState: {
      sorting: [{ id: "createdAt", desc: true }],
      columnPinning: { right: ["actions"] },
    },
    getRowId: (originalRow) => originalRow.id,
    shallow: false,
    clearOnDefault: true,
  })

  const selected = rowAction?.row.original ?? null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-bold text-xl">
          {t("companies.title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <DataTable table={table}>
          <DataTableToolbar table={table}>
            {table.getFilteredSelectedRowModel().rows.length > 0 ? (
              <DeleteCompaniesDialog
                companies={table
                  .getFilteredSelectedRowModel()
                  .rows.map((row) => row.original)}
                onSuccess={() => table.toggleAllRowsSelected(false)}
                workspaceId={workspaceId}
              />
            ) : null}
            <CreateCompanyDialog workspaceId={workspaceId} />
          </DataTableToolbar>
        </DataTable>

        <DeleteCompaniesDialog
          companies={selected ? [selected] : []}
          onOpenChange={() => setRowAction(null)}
          onSuccess={() => rowAction?.row.toggleSelected(false)}
          open={rowAction?.variant === "delete"}
          showTrigger={false}
          workspaceId={workspaceId}
        />
        <UpdateCompanyDialog
          company={selected}
          onOpenChange={() => setRowAction(null)}
          open={rowAction?.variant === "update"}
          workspaceId={workspaceId}
        />
        <StopCompanyDialog
          company={stopTarget}
          onOpenChange={(isOpen) => {
            if (!isOpen) {
              setStopTarget(null)
            }
          }}
          open={stopTarget !== null}
          showTrigger={false}
          workspaceId={workspaceId}
        />
      </CardContent>
    </Card>
  )
}
