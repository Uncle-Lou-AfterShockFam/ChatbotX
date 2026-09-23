"use client"

import { DataTableColumnHeader } from "@chatbotx.io/ui/components/data-table/data-table-column-header"
import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Checkbox } from "@chatbotx.io/ui/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@chatbotx.io/ui/components/ui/dropdown-menu"
import type { DataTableRowAction } from "@chatbotx.io/ui/types/data-table"
import type { ColumnDef } from "@tanstack/react-table"
import {
  EllipsisVerticalIcon,
  OctagonXIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react"
import Link from "next/link"
import type { useTranslations } from "next-intl"
import type { Dispatch, SetStateAction } from "react"
import type { CompanyWithContactCountResource } from "./schema/resource"

type Row = CompanyWithContactCountResource

type GetColumnsProps = {
  workspaceId: string
  setRowAction: Dispatch<SetStateAction<DataTableRowAction<Row> | null>>
  onStop: (company: Row) => void
  t: ReturnType<typeof useTranslations>
}

export function getCompanyColumns({
  workspaceId,
  setRowAction,
  onStop,
  t,
}: GetColumnsProps): ColumnDef<Row>[] {
  return [
    {
      id: "select",
      header: ({ table }) => (
        <Checkbox
          aria-label={t("actions.selectAll")}
          checked={table.getIsAllPageRowsSelected()}
          className="translate-y-0.5"
          indeterminate={table.getIsSomePageRowsSelected()}
          onCheckedChange={(value) =>
            table.toggleAllPageRowsSelected(Boolean(value))
          }
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label={t("actions.selectRow")}
          checked={row.getIsSelected()}
          className="translate-y-0.5"
          onCheckedChange={(value) => row.toggleSelected(Boolean(value))}
        />
      ),
      size: 50,
      enableSorting: false,
      enableHiding: false,
    },
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title={t("fields.name.label")} />
      ),
      cell: ({ row }) => (
        <Link
          className="max-w-[300px] truncate font-medium hover:underline"
          href={`/space/${workspaceId}/companies/${row.original.id}`}
        >
          {row.original.name}
        </Link>
      ),
      size: 260,
      meta: {
        label: t("fields.name.label"),
        placeholder: t("fields.name.placeholder"),
        variant: "text",
      },
      enableColumnFilter: true,
      enableSorting: true,
    },
    {
      id: "domains",
      header: t("companies.fields.domains"),
      cell: ({ row }) => (
        <div className="flex max-w-[320px] flex-wrap gap-1">
          {row.original.domains.map((domain) => (
            <Badge key={domain} variant="secondary">
              {domain}
            </Badge>
          ))}
        </div>
      ),
      size: 320,
      enableSorting: false,
    },
    {
      id: "contactCount",
      header: t("companies.fields.contactCount"),
      cell: ({ row }) => <div>{row.original.contactCount}</div>,
      size: 90,
      enableSorting: false,
    },
    {
      id: "stoppedAt",
      accessorKey: "stoppedAt",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title={t("companies.status")} />
      ),
      cell: ({ row }) =>
        row.original.stoppedAt ? (
          <Badge variant="destructive">
            {t("companies.stopped")}
            {row.original.stopReason ? ` (${row.original.stopReason})` : ""}
          </Badge>
        ) : (
          <Badge variant="outline">{t("companies.active")}</Badge>
        ),
      size: 160,
      enableSorting: true,
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label="Open menu"
                className="flex size-8 p-0 data-[state=open]:bg-muted"
                variant="ghost"
              >
                <EllipsisVerticalIcon aria-hidden="true" className="size-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem
              onClick={() => setRowAction({ row, variant: "update" })}
            >
              <PencilIcon />
              {t("actions.edit")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onStop(row.original)}>
              <OctagonXIcon />
              {row.original.stoppedAt
                ? t("companies.rerunStop")
                : t("companies.stop")}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive"
              onClick={() => setRowAction({ row, variant: "delete" })}
            >
              <Trash2Icon className="text-destructive" />
              {t("actions.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
      size: 50,
      enableSorting: false,
      enableHiding: false,
    },
  ]
}
