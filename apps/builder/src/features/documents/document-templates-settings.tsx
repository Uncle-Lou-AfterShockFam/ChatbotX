"use client"

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
import { DocumentEditor } from "./document-editor"
import {
  useCreateDocumentTemplate,
  useDeleteDocumentTemplate,
  useDocumentTemplates,
  useSetDocumentTemplateStatus,
  useUpdateDocumentTemplate,
} from "./provider/document-hooks"
import type { DocumentTemplateResource } from "./schema/resource"

const NEW = "new"
const errorMessage = (err: unknown) =>
  err instanceof Error && err.message ? err.message : String(err)

/** Settings > Documents: the template list and its editor (roadmap B3). */
export function DocumentTemplatesSettings({
  workspaceId,
}: {
  workspaceId: string
}) {
  const t = useTranslations()
  const [showArchived, setShowArchived] = useState(false)
  const templates = useDocumentTemplates(workspaceId, showArchived)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const list = templates.data ?? []
  const selected =
    selectedId === NEW ? null : (list.find((x) => x.id === selectedId) ?? null)

  return (
    <div className="grid gap-4 px-4 py-4 md:grid-cols-[280px_1fr] md:px-6">
      <Card>
        <CardContent className="space-y-3 p-3">
          <Button
            className="w-full"
            data-testid="document-template-new"
            onClick={() => setSelectedId(NEW)}
            size="sm"
          >
            <PlusIcon className="me-1 size-4" />
            {t("documents.newTemplate")}
          </Button>
          <label
            className="flex items-center justify-between gap-2 text-muted-foreground text-xs"
            htmlFor="doc-show-archived"
          >
            {t("documents.showArchived")}
            <Switch
              checked={showArchived}
              id="doc-show-archived"
              onCheckedChange={(v) => setShowArchived(Boolean(v))}
            />
          </label>
          {list.length === 0 && !templates.isLoading ? (
            <p className="py-6 text-center text-muted-foreground text-sm">
              {t("documents.noTemplates")}
            </p>
          ) : null}
          <ul className="space-y-1">
            {list.map((tpl) => (
              <li key={tpl.id}>
                <button
                  className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-start text-sm hover:bg-muted ${selectedId === tpl.id ? "bg-muted" : ""}`}
                  data-testid={`document-template-${tpl.id}`}
                  onClick={() => setSelectedId(tpl.id)}
                  type="button"
                >
                  <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{tpl.name}</span>
                  {tpl.status === "archived" ? (
                    <Badge variant="outline">{t("documents.archived")}</Badge>
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
            {t("documents.pickOrCreate")}
          </CardContent>
        </Card>
      ) : (
        <TemplateEditorCard
          key={selectedId}
          onCreated={(id) => setSelectedId(id)}
          onDeleted={() => setSelectedId(null)}
          template={selected}
          workspaceId={workspaceId}
        />
      )}
    </div>
  )
}

function TemplateEditorCard({
  workspaceId,
  template,
  onCreated,
  onDeleted,
}: {
  workspaceId: string
  template: DocumentTemplateResource | null
  onCreated: (id: string) => void
  onDeleted: () => void
}) {
  const t = useTranslations()
  const [name, setName] = useState(template?.name ?? "")
  const [bodyHtml, setBodyHtml] = useState(template?.bodyHtml ?? "")
  const create = useCreateDocumentTemplate()
  const update = useUpdateDocumentTemplate()
  const setStatus = useSetDocumentTemplateStatus()
  const remove = useDeleteDocumentTemplate()
  const saving = create.isPending || update.isPending

  const save = async () => {
    try {
      if (template) {
        await update.mutateAsync({
          workspaceId,
          id: template.id,
          name,
          bodyHtml,
        })
      } else {
        const created = await create.mutateAsync({
          workspaceId,
          name,
          bodyHtml,
        })
        onCreated(created.id)
      }
      toast.success(t("documents.saved"))
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <label className="font-medium text-sm" htmlFor="doc-template-name">
              {t("documents.name")}
            </label>
            <Input
              data-testid="document-template-name"
              id="doc-template-name"
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("documents.namePlaceholder")}
              value={name}
            />
          </div>
          <Button
            data-testid="document-template-save"
            disabled={saving || name.trim() === "" || bodyHtml.trim() === ""}
            onClick={save}
          >
            {t("actions.save")}
          </Button>
          {template ? (
            <>
              <Button
                onClick={() =>
                  setStatus.mutate(
                    {
                      workspaceId,
                      id: template.id,
                      status:
                        template.status === "active" ? "archived" : "active",
                    },
                    { onError: (err) => toast.error(errorMessage(err)) },
                  )
                }
                variant="outline"
              >
                {template.status === "active"
                  ? t("actions.archive")
                  : t("actions.restore")}
              </Button>
              <ConfirmButton
                description={t("documents.deleteConfirm")}
                onConfirm={() =>
                  remove.mutate(
                    { workspaceId, id: template.id },
                    {
                      onSuccess: onDeleted,
                      onError: (err) => toast.error(errorMessage(err)),
                    },
                  )
                }
                title={t("documents.deleteTitle")}
                variant="destructive"
              >
                {t("actions.delete")}
              </ConfirmButton>
            </>
          ) : null}
        </div>
        <DocumentEditor
          initialHtml={template?.bodyHtml ?? ""}
          onChange={setBodyHtml}
        />
      </CardContent>
    </Card>
  )
}
