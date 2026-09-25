"use client"

import { normalizeFormDefinition } from "@chatbotx.io/database/partials"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@chatbotx.io/ui/components/ui/sheet"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@chatbotx.io/ui/components/ui/table"
import { formInputFields } from "@chatbotx.io/utils/form"
import { Loader2Icon, Trash2Icon } from "lucide-react"
import Link from "next/link"
import { useFormatter, useTranslations } from "next-intl"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import {
  useDeleteFormSubmission,
  useForm,
  useFormSubmissions,
} from "../provider/form-hooks"
import type { FormSubmissionResource } from "../schema/resource"

const MAX_COLUMNS = 6

const cell = (value: unknown): string => {
  if (value === undefined || value === null) {
    return ""
  }
  if (Array.isArray(value)) {
    return value.map(String).join(", ")
  }
  if (typeof value === "boolean") {
    return value ? "yes" : "no"
  }
  return String(value)
}

/**
 * A form's submissions, newest first (s200). Columns come from the union of
 * the current input fields and the keys found in the loaded rows, so a row
 * answered on an older version still shows every value it carries.
 */
export function FormSubmissions(props: { workspaceId: string; id: string }) {
  const { workspaceId, id } = props
  const t = useTranslations()
  const format = useFormatter()
  const form = useForm(workspaceId, id)
  const submissions = useFormSubmissions(workspaceId, id)
  const remove = useDeleteFormSubmission()
  const [open, setOpen] = useState<FormSubmissionResource | null>(null)
  const rows = useMemo(
    () => submissions.data?.pages.flatMap((p) => p.data) ?? [],
    [submissions.data],
  )
  const fields = useMemo(() => {
    const def = form.data
      ? normalizeFormDefinition(
          form.data.publishedDefinition ?? form.data.definition,
        )
      : null
    const labels = new Map<string, string>()
    for (const f of def ? formInputFields(def) : []) {
      labels.set(f.key, f.label || f.key)
    }
    for (const row of rows) {
      for (const key of Object.keys(row.values)) {
        if (!labels.has(key)) {
          labels.set(key, key)
        }
      }
    }
    return [...labels.entries()]
  }, [form.data, rows])
  const columns = fields.slice(0, MAX_COLUMNS)

  return (
    <div className="flex flex-col gap-4" data-testid="form-submissions">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="me-auto font-semibold text-lg">
          {form.data?.title ?? ""} · {t("forms.submissions.title")}
        </h1>
        {submissions.isFetching ? (
          <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
        ) : null}
      </div>
      {rows.length === 0 && !submissions.isLoading ? (
        <p className="py-8 text-center text-muted-foreground text-sm">
          {t("forms.submissions.empty")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("forms.submissions.submitted")}</TableHead>
                <TableHead>{t("forms.submissions.contact")}</TableHead>
                {columns.map(([key, label]) => (
                  <TableHead key={key}>{label}</TableHead>
                ))}
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  className="cursor-pointer"
                  data-testid={`submission-row-${row.id}`}
                  key={row.id}
                  onClick={() => setOpen(row)}
                >
                  <TableCell className="whitespace-nowrap text-xs">
                    {format.dateTime(row.createdAt, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </TableCell>
                  <TableCell className="text-xs">
                    {row.contactId ? (
                      <Link
                        className="hover:underline"
                        href={`/space/${workspaceId}/contacts/${row.contactId}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {t("forms.submissions.openContact")}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">
                        {t("forms.submissions.anonymous")}
                      </span>
                    )}
                  </TableCell>
                  {columns.map(([key]) => (
                    <TableCell className="max-w-48 truncate text-xs" key={key}>
                      {cell(row.values[key])}
                    </TableCell>
                  ))}
                  <TableCell>
                    <Button
                      aria-label={t("actions.delete")}
                      disabled={remove.isPending}
                      onClick={(e) => {
                        e.stopPropagation()
                        remove.mutate(
                          { workspaceId, id, submissionId: row.id },
                          { onError: (error) => toast.error(error.message) },
                        )
                      }}
                      size="icon"
                      variant="ghost"
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {submissions.hasNextPage ? (
        <Button
          className="self-center"
          disabled={submissions.isFetchingNextPage}
          onClick={() => submissions.fetchNextPage()}
          size="sm"
          variant="outline"
        >
          {t("forms.submissions.more")}
        </Button>
      ) : null}
      <Sheet onOpenChange={(o) => !o && setOpen(null)} open={open !== null}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t("forms.submissions.detail")}</SheetTitle>
            <SheetDescription>
              {open
                ? format.dateTime(open.createdAt, {
                    dateStyle: "long",
                    timeStyle: "short",
                  })
                : ""}
              {open ? ` · v${open.definitionVersion}` : ""}
            </SheetDescription>
          </SheetHeader>
          {open ? (
            <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-2 px-4 text-sm">
              {fields.map(([key, label]) => (
                <div className="contents" key={key}>
                  <dt className="truncate text-muted-foreground">{label}</dt>
                  <dd className="break-words">
                    {cell(open.values[key]) || "—"}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  )
}
