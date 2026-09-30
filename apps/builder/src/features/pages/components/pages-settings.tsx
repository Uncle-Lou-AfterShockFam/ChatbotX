"use client"

import {
  PAGE_LINK_TTL_DEFAULT_HOURS,
  PAGE_LINK_TTL_MAX_HOURS,
  PAGE_LINK_TTL_MIN_HOURS,
} from "@chatbotx.io/database/partials"
import type { EmailDocument } from "@chatbotx.io/email-document"
import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Card, CardContent } from "@chatbotx.io/ui/components/ui/card"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import { Switch } from "@chatbotx.io/ui/components/ui/switch"
import { FileTextIcon, PlusIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { toast } from "sonner"
import { ConfirmButton } from "@/components/confirm-button"
import { EmailDocumentEditor } from "@/features/email-templates/components/email-document-editor"
import {
  emptyDocument,
  toEditable,
} from "@/features/email-templates/lib/document-model"
import {
  useCreatePage,
  useDeletePage,
  usePages,
  useSetPageStatus,
  useUpdatePage,
} from "../provider/page-hooks"
import type { PageResource } from "../schema/resource"

const NEW = "new"
const errorMessage = (err: unknown) =>
  err instanceof Error && err.message ? err.message : String(err)

/**
 * Settings > Pages (roadmap B4): the page list and the same block editor as
 * email templates, previewed as the public page. Contacts reach a page only
 * through the link a flow sends them (`/p/<token>`, expiring).
 */
export function PagesSettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("pages")
  const [showArchived, setShowArchived] = useState(false)
  const pages = usePages(workspaceId, showArchived)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const list = pages.data ?? []
  const selected =
    selectedId === NEW ? null : (list.find((x) => x.id === selectedId) ?? null)

  return (
    <div className="grid gap-4 px-4 py-4 md:px-6 lg:grid-cols-[240px_minmax(0,1fr)]">
      <Card className="self-start">
        <CardContent className="space-y-3 p-3">
          <Button
            className="w-full"
            data-testid="page-new"
            onClick={() => setSelectedId(NEW)}
            size="sm"
          >
            <PlusIcon className="me-1 size-4" />
            {t("newPage")}
          </Button>
          <label
            className="flex items-center justify-between gap-2 text-muted-foreground text-xs"
            htmlFor="page-show-archived"
          >
            {t("showArchived")}
            <Switch
              checked={showArchived}
              id="page-show-archived"
              onCheckedChange={(v) => setShowArchived(Boolean(v))}
            />
          </label>
          {list.length === 0 && !pages.isLoading ? (
            <p className="py-6 text-center text-muted-foreground text-sm">
              {t("noPages")}
            </p>
          ) : null}
          <ul className="space-y-1">
            {list.map((tpl) => (
              <li key={tpl.id}>
                <button
                  className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-start text-sm hover:bg-muted ${selectedId === tpl.id ? "bg-muted" : ""}`}
                  data-testid={`page-${tpl.id}`}
                  onClick={() => setSelectedId(tpl.id)}
                  type="button"
                >
                  <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{tpl.name}</span>
                  {tpl.status === "archived" ? (
                    <Badge variant="outline">{t("archived")}</Badge>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {selectedId === null ? (
        <Card>
          <CardContent className="flex min-h-[300px] items-center justify-center p-6 text-center text-muted-foreground text-sm">
            {t("pickOrCreate")}
          </CardContent>
        </Card>
      ) : (
        <PageEditor
          key={selectedId}
          onCreated={(id) => setSelectedId(id)}
          onDeleted={() => setSelectedId(null)}
          page={selected}
          workspaceId={workspaceId}
        />
      )}
    </div>
  )
}

function PageEditor({
  workspaceId,
  page,
  onCreated,
  onDeleted,
}: {
  workspaceId: string
  page: PageResource | null
  onCreated: (id: string) => void
  onDeleted: () => void
}) {
  const t = useTranslations()
  const [name, setName] = useState(page?.name ?? "")
  const [ttl, setTtl] = useState(
    String(page?.linkTtlHours ?? PAGE_LINK_TTL_DEFAULT_HOURS),
  )
  const [document, setDocument] = useState<EmailDocument>(() =>
    page ? toEditable(page.document) : emptyDocument(),
  )
  const create = useCreatePage()
  const update = useUpdatePage()
  const setStatus = useSetPageStatus()
  const remove = useDeletePage()
  const saving = create.isPending || update.isPending
  const [valid, setValid] = useState(false)
  const linkTtlHours = Number(ttl)
  const ttlValid =
    Number.isInteger(linkTtlHours) &&
    linkTtlHours >= PAGE_LINK_TTL_MIN_HOURS &&
    linkTtlHours <= PAGE_LINK_TTL_MAX_HOURS

  const save = async () => {
    const body = document as unknown as Record<string, unknown>
    try {
      if (page) {
        await update.mutateAsync({
          workspaceId,
          id: page.id,
          name,
          document: body,
          linkTtlHours,
        })
      } else {
        const created = await create.mutateAsync({
          workspaceId,
          name,
          document: body,
          linkTtlHours,
        })
        onCreated(created.id)
      }
      toast.success(t("pages.saved"))
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-2 p-3">
          <div className="min-w-0 flex-1 space-y-1">
            <label className="font-medium text-sm" htmlFor="page-name">
              {t("pages.name")}
            </label>
            <Input
              data-testid="page-name"
              id="page-name"
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("pages.namePlaceholder")}
              value={name}
            />
          </div>
          <div className="w-32 space-y-1">
            <label className="font-medium text-sm" htmlFor="page-ttl">
              {t("pages.linkTtlHours")}
            </label>
            <Input
              aria-invalid={!ttlValid}
              data-testid="page-ttl"
              id="page-ttl"
              inputMode="numeric"
              max={PAGE_LINK_TTL_MAX_HOURS}
              min={PAGE_LINK_TTL_MIN_HOURS}
              onChange={(e) => setTtl(e.target.value)}
              step={1}
              type="number"
              value={ttl}
            />
          </div>
          <Button
            data-testid="page-save"
            disabled={
              saving ||
              !valid ||
              !ttlValid ||
              name.trim() === "" ||
              document.blocks.length === 0
            }
            onClick={save}
          >
            {t("actions.save")}
          </Button>
          {page ? (
            <>
              <Button
                onClick={() =>
                  setStatus.mutate(
                    {
                      workspaceId,
                      id: page.id,
                      status: page.status === "active" ? "archived" : "active",
                    },
                    { onError: (err) => toast.error(errorMessage(err)) },
                  )
                }
                variant="outline"
              >
                {page.status === "active"
                  ? t("actions.archive")
                  : t("actions.restore")}
              </Button>
              <ConfirmButton
                description={t("pages.deleteConfirm")}
                onConfirm={() =>
                  remove.mutate(
                    { workspaceId, id: page.id },
                    {
                      onSuccess: onDeleted,
                      onError: (err) => toast.error(errorMessage(err)),
                    },
                  )
                }
                title={t("pages.deleteTitle")}
                variant="destructive"
              >
                {t("actions.delete")}
              </ConfirmButton>
            </>
          ) : null}
          <p className="basis-full text-muted-foreground text-xs">
            {t("pages.linkHint")}
          </p>
        </CardContent>
      </Card>
      <EmailDocumentEditor
        onChange={setDocument}
        onValidChange={setValid}
        previewAs="page"
        value={document}
        workspaceId={workspaceId}
      />
    </div>
  )
}
