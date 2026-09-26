"use client"

import type { InvoiceStatus } from "@chatbotx.io/database/partials"
import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@chatbotx.io/ui/components/ui/table"
import {
  BanIcon,
  CopyIcon,
  ExternalLinkIcon,
  Loader2Icon,
  RotateCwIcon,
} from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  useFinalizeInvoice,
  useInvoices,
  useVoidInvoice,
} from "../provider/invoice-hooks"
import type { InvoiceResource } from "../schema/resource"

const STATUS_VARIANT = {
  draft: "outline",
  open: "secondary",
  paid: "default",
  void: "outline",
  uncollectible: "destructive",
  refunded: "outline",
} as const satisfies Record<
  InvoiceStatus,
  "default" | "secondary" | "outline" | "destructive"
>

const VOIDABLE: ReadonlySet<InvoiceStatus> = new Set([
  "draft",
  "open",
  "uncollectible",
])

/** Invoice rows of a workspace (optionally one contact), keyset-paged. */
export function InvoiceList({
  workspaceId,
  contactId,
  status,
}: {
  workspaceId: string
  contactId?: string
  status?: InvoiceStatus
}) {
  const t = useTranslations()
  const format = useFormatter()
  const invoices = useInvoices(workspaceId, { contactId, status })
  const voidInvoice = useVoidInvoice()
  const finalizeInvoice = useFinalizeInvoice()
  const rows = invoices.data?.pages.flatMap((page) => page.data) ?? []

  const money = (row: InvoiceResource) =>
    format.number(Number(row.total), {
      style: "currency",
      currency: row.currency,
    })

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t("invoices.linkCopied"))
    } catch {
      toast.error(t("invoices.linkCopyFailed"))
    }
  }

  const onVoid = (row: InvoiceResource) =>
    voidInvoice.mutate(
      { workspaceId, id: row.id },
      {
        onSuccess: () => toast.success(t("invoices.voided")),
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : String(err)),
      },
    )

  const onRetry = (row: InvoiceResource) =>
    finalizeInvoice.mutate(
      { workspaceId, id: row.id },
      {
        onSuccess: () => toast.success(t("invoices.retried")),
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : String(err)),
      },
    )

  if (invoices.isLoading) {
    return <Loader2Icon className="size-4 animate-spin" />
  }
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm" data-testid="invoices-empty">
        {t("invoices.empty")}
      </p>
    )
  }
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <Table data-testid="invoices-table">
          <TableHeader>
            <TableRow>
              <TableHead>{t("invoices.fields.number")}</TableHead>
              <TableHead>{t("invoices.fields.status")}</TableHead>
              <TableHead className="text-right">
                {t("invoices.fields.total")}
              </TableHead>
              <TableHead>{t("invoices.fields.created")}</TableHead>
              <TableHead>{t("invoices.fields.due")}</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">{t("actions.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow data-testid={`invoice-row-${row.id}`} key={row.id}>
                <TableCell className="font-medium">#{row.number}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[row.status]}>
                    {t(`invoices.status.${row.status}`)}
                  </Badge>
                  {/* A draft's failed send, or (s207b) a payment that needs a human. */}
                  {row.lastError ? (
                    <p
                      className="mt-1 max-w-64 truncate text-destructive text-xs"
                      title={row.lastError}
                    >
                      {row.lastError}
                    </p>
                  ) : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {money(row)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {format.dateTime(row.createdAt, { dateStyle: "medium" })}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {row.dueAt
                    ? format.dateTime(row.dueAt, {
                        dateStyle: "medium",
                        // A due DATE, the hub convention since s192: its UTC day.
                        timeZone: "UTC",
                      })
                    : "-"}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    {row.hostedUrl ? (
                      <>
                        <Button
                          aria-label={t("invoices.copyLink")}
                          onClick={() => copyLink(row.hostedUrl as string)}
                          size="icon"
                          variant="ghost"
                        >
                          <CopyIcon className="size-4" />
                        </Button>
                        <Button
                          aria-label={t("invoices.openLink")}
                          render={
                            // biome-ignore lint/a11y/useAnchorContent: the Button renders its icon into this anchor
                            <a
                              href={row.hostedUrl}
                              rel="noopener noreferrer"
                              target="_blank"
                            />
                          }
                          size="icon"
                          variant="ghost"
                        >
                          <ExternalLinkIcon className="size-4" />
                        </Button>
                      </>
                    ) : null}
                    {row.status === "draft" ? (
                      <Button
                        aria-label={t("invoices.retry")}
                        data-testid={`invoice-retry-${row.id}`}
                        disabled={finalizeInvoice.isPending}
                        onClick={() => onRetry(row)}
                        size="icon"
                        variant="ghost"
                      >
                        <RotateCwIcon className="size-4" />
                      </Button>
                    ) : null}
                    {VOIDABLE.has(row.status) ? (
                      <Button
                        aria-label={t("invoices.void")}
                        data-testid={`invoice-void-${row.id}`}
                        disabled={voidInvoice.isPending}
                        onClick={() => onVoid(row)}
                        size="icon"
                        variant="ghost"
                      >
                        <BanIcon className="size-4" />
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {invoices.hasNextPage ? (
        <Button
          disabled={invoices.isFetchingNextPage}
          onClick={() => invoices.fetchNextPage()}
          size="sm"
          variant="outline"
        >
          {t("actions.loadMore")}
        </Button>
      ) : null}
    </div>
  )
}
