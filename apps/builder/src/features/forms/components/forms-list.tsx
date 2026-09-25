"use client"

import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@chatbotx.io/ui/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@chatbotx.io/ui/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@chatbotx.io/ui/components/ui/dropdown-menu"
import { Label } from "@chatbotx.io/ui/components/ui/label"
import { Switch } from "@chatbotx.io/ui/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@chatbotx.io/ui/components/ui/table"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CopyPlusIcon,
  EllipsisVerticalIcon,
  ListChecksIcon,
  Loader2Icon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useFormatter, useTranslations } from "next-intl"
import { useState } from "react"
import { toast } from "sonner"
import {
  useDeleteForm,
  useDuplicateForm,
  useForms,
  useSetFormStatus,
} from "../provider/form-hooks"
import type { FormSummaryResource } from "../schema/resource"
import { CreateFormDialog } from "./create-form-dialog"

/** The workspace's forms (s200): title, slug, status, submission count, actions. */
export function FormsList({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations()
  const format = useFormatter()
  const router = useRouter()
  const [includeArchived, setIncludeArchived] = useState(false)
  const forms = useForms(workspaceId, includeArchived)
  const duplicate = useDuplicateForm()
  const setStatus = useSetFormStatus()
  const remove = useDeleteForm()
  const [toDelete, setToDelete] = useState<FormSummaryResource | null>(null)
  const onError = (error: Error) => toast.error(error.message)

  return (
    <Card data-testid="forms-list">
      <CardHeader className="flex flex-wrap items-center gap-2">
        <CardTitle className="me-auto font-bold text-xl">
          {t("forms.title")}
        </CardTitle>
        {forms.isFetching ? (
          <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
        ) : null}
        <div className="flex items-center gap-2 text-sm">
          <Switch
            checked={includeArchived}
            id="forms-show-archived"
            onCheckedChange={setIncludeArchived}
          />
          <Label htmlFor="forms-show-archived">{t("forms.showArchived")}</Label>
        </div>
        <CreateFormDialog workspaceId={workspaceId} />
      </CardHeader>
      <CardContent>
        {forms.data?.length === 0 ? (
          <p className="py-8 text-center text-muted-foreground text-sm">
            {t("forms.empty")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("forms.columns.title")}</TableHead>
                  <TableHead>{t("forms.columns.slug")}</TableHead>
                  <TableHead>{t("forms.columns.status")}</TableHead>
                  <TableHead className="text-end">
                    {t("forms.columns.submissions")}
                  </TableHead>
                  <TableHead>{t("forms.columns.updated")}</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(forms.data ?? []).map((form) => (
                  <TableRow data-testid={`form-row-${form.slug}`} key={form.id}>
                    <TableCell>
                      <Link
                        className="font-medium hover:underline"
                        href={`/space/${workspaceId}/forms/${form.id}/edit`}
                      >
                        {form.title}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {form.slug}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          form.status === "published" ? "default" : "secondary"
                        }
                      >
                        {t(`forms.status.${form.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-end">
                      {form.submissionCount}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {format.dateTime(form.updatedAt, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              aria-label={t("actions.openMenu")}
                              className="size-8 p-0"
                              variant="ghost"
                            >
                              <EllipsisVerticalIcon className="size-4" />
                            </Button>
                          }
                        />
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            render={
                              <Link
                                href={`/space/${workspaceId}/forms/${form.id}/edit`}
                              >
                                <PencilIcon />
                                {t("actions.edit")}
                              </Link>
                            }
                          />
                          <DropdownMenuItem
                            render={
                              <Link
                                href={`/space/${workspaceId}/forms/${form.id}/submissions`}
                              >
                                <ListChecksIcon />
                                {t("forms.submissions.title")}
                              </Link>
                            }
                          />
                          <DropdownMenuItem
                            onClick={() =>
                              duplicate.mutate(
                                { workspaceId, id: form.id },
                                {
                                  onSuccess: (copy) =>
                                    router.push(
                                      `/space/${workspaceId}/forms/${copy.id}/edit`,
                                    ),
                                  onError,
                                },
                              )
                            }
                          >
                            <CopyPlusIcon />
                            {t("actions.duplicate")}
                          </DropdownMenuItem>
                          {form.status === "archived" ? (
                            <DropdownMenuItem
                              onClick={() =>
                                setStatus.mutate(
                                  { workspaceId, id: form.id, status: "draft" },
                                  { onError },
                                )
                              }
                            >
                              <ArchiveRestoreIcon />
                              {t("forms.actions.restore")}
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              onClick={() =>
                                setStatus.mutate(
                                  {
                                    workspaceId,
                                    id: form.id,
                                    status: "archived",
                                  },
                                  { onError },
                                )
                              }
                            >
                              <ArchiveIcon />
                              {t("forms.actions.archive")}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onClick={() => setToDelete(form)}
                            variant="destructive"
                          >
                            <Trash2Icon />
                            {t("actions.delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <Dialog
          onOpenChange={(open) => !open && setToDelete(null)}
          open={toDelete !== null}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {t("messages.deleteFeature", { feature: t("forms.singular") })}
              </DialogTitle>
              <DialogDescription>
                {t("forms.deleteConfirm", {
                  count: toDelete?.submissionCount ?? 0,
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => setToDelete(null)} variant="ghost">
                {t("actions.cancel")}
              </Button>
              <Button
                data-testid="confirm-delete-form"
                disabled={remove.isPending || toDelete === null}
                onClick={() =>
                  toDelete &&
                  remove.mutate(
                    { workspaceId, id: toDelete.id },
                    {
                      onSuccess: () => {
                        toast.success(
                          t("messages.deletedSuccess", {
                            feature: t("forms.singular"),
                          }),
                        )
                        setToDelete(null)
                      },
                      onError,
                    },
                  )
                }
                variant="destructive"
              >
                {remove.isPending ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <Trash2Icon className="size-4" />
                )}
                {t("actions.delete")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
}
