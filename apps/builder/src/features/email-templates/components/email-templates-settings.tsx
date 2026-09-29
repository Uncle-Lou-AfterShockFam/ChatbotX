"use client"

import type { EmailDocument } from "@chatbotx.io/email-document"
import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Card, CardContent } from "@chatbotx.io/ui/components/ui/card"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import { Switch } from "@chatbotx.io/ui/components/ui/switch"
import { MailIcon, PlusIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { toast } from "sonner"
import { ConfirmButton } from "@/components/confirm-button"
import { emptyDocument, toEditable } from "../lib/document-model"
import {
  useCreateEmailTemplate,
  useDeleteEmailTemplate,
  useEmailTemplates,
  useSetEmailTemplateStatus,
  useUpdateEmailTemplate,
} from "../provider/email-template-hooks"
import type { EmailTemplateResource } from "../schema/resource"
import { EmailDocumentEditor } from "./email-document-editor"

const NEW = "new"
const errorMessage = (err: unknown) =>
  err instanceof Error && err.message ? err.message : String(err)

/** Settings > Email templates: the template list and the block editor (B2 phase 3). */
export function EmailTemplatesSettings({
  workspaceId,
}: {
  workspaceId: string
}) {
  const t = useTranslations("emailTemplates")
  const [showArchived, setShowArchived] = useState(false)
  const templates = useEmailTemplates(workspaceId, showArchived)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const list = templates.data ?? []
  const selected =
    selectedId === NEW ? null : (list.find((x) => x.id === selectedId) ?? null)

  return (
    <div className="grid gap-4 px-4 py-4 md:px-6 lg:grid-cols-[240px_minmax(0,1fr)]">
      <Card className="self-start">
        <CardContent className="space-y-3 p-3">
          <Button
            className="w-full"
            data-testid="email-template-new"
            onClick={() => setSelectedId(NEW)}
            size="sm"
          >
            <PlusIcon className="me-1 size-4" />
            {t("newTemplate")}
          </Button>
          <label
            className="flex items-center justify-between gap-2 text-muted-foreground text-xs"
            htmlFor="email-show-archived"
          >
            {t("showArchived")}
            <Switch
              checked={showArchived}
              id="email-show-archived"
              onCheckedChange={(v) => setShowArchived(Boolean(v))}
            />
          </label>
          {list.length === 0 && !templates.isLoading ? (
            <p className="py-6 text-center text-muted-foreground text-sm">
              {t("noTemplates")}
            </p>
          ) : null}
          <ul className="space-y-1">
            {list.map((tpl) => (
              <li key={tpl.id}>
                <button
                  className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-start text-sm hover:bg-muted ${selectedId === tpl.id ? "bg-muted" : ""}`}
                  data-testid={`email-template-${tpl.id}`}
                  onClick={() => setSelectedId(tpl.id)}
                  type="button"
                >
                  <MailIcon className="size-4 shrink-0 text-muted-foreground" />
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
        <TemplateEditor
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

function TemplateEditor({
  workspaceId,
  template,
  onCreated,
  onDeleted,
}: {
  workspaceId: string
  template: EmailTemplateResource | null
  onCreated: (id: string) => void
  onDeleted: () => void
}) {
  const t = useTranslations()
  const [name, setName] = useState(template?.name ?? "")
  const [document, setDocument] = useState<EmailDocument>(() =>
    template ? toEditable(template.document) : emptyDocument(),
  )
  const create = useCreateEmailTemplate()
  const update = useUpdateEmailTemplate()
  const setStatus = useSetEmailTemplateStatus()
  const remove = useDeleteEmailTemplate()
  const saving = create.isPending || update.isPending
  const [valid, setValid] = useState(false)

  const save = async () => {
    const body = document as unknown as Record<string, unknown>
    try {
      if (template) {
        await update.mutateAsync({
          workspaceId,
          id: template.id,
          name,
          document: body,
        })
      } else {
        const created = await create.mutateAsync({
          workspaceId,
          name,
          document: body,
        })
        onCreated(created.id)
      }
      toast.success(t("emailTemplates.saved"))
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-2 p-3">
          <div className="min-w-0 flex-1 space-y-1">
            <label
              className="font-medium text-sm"
              htmlFor="email-template-name"
            >
              {t("emailTemplates.name")}
            </label>
            <Input
              data-testid="email-template-name"
              id="email-template-name"
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("emailTemplates.namePlaceholder")}
              value={name}
            />
          </div>
          <Button
            data-testid="email-template-save"
            disabled={
              saving ||
              !valid ||
              name.trim() === "" ||
              document.blocks.length === 0
            }
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
                description={t("emailTemplates.deleteConfirm")}
                onConfirm={() =>
                  remove.mutate(
                    { workspaceId, id: template.id },
                    {
                      onSuccess: onDeleted,
                      onError: (err) => toast.error(errorMessage(err)),
                    },
                  )
                }
                title={t("emailTemplates.deleteTitle")}
                variant="destructive"
              >
                {t("actions.delete")}
              </ConfirmButton>
            </>
          ) : null}
        </CardContent>
      </Card>
      <EmailDocumentEditor
        onChange={setDocument}
        onValidChange={setValid}
        value={document}
        workspaceId={workspaceId}
      />
    </div>
  )
}
