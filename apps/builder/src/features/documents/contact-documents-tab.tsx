"use client"

import type { ContactDocumentStatus } from "@chatbotx.io/database/partials"
import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import { ExternalLinkIcon, FileTextIcon, Loader2Icon } from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import { useState } from "react"
import { toast } from "sonner"
import {
  useContactDocuments,
  useDocumentTemplates,
  useGenerateContactDocument,
} from "./provider/document-hooks"

const statusKey = {
  generated: "documents.status.generated",
  sent: "documents.status.sent",
  signed: "documents.status.signed",
  failed: "documents.status.failed",
} as const satisfies Record<ContactDocumentStatus, string>

/** Contact 360 > Documents: generate from a template, open the stored PDFs. */
export function ContactDocumentsTab({
  workspaceId,
  contactId,
}: {
  workspaceId: string
  contactId: string
}) {
  const t = useTranslations()
  const format = useFormatter()
  const documents = useContactDocuments(workspaceId, contactId)
  const templates = useDocumentTemplates(workspaceId)
  const generate = useGenerateContactDocument()
  const [templateId, setTemplateId] = useState("")
  const options = (templates.data ?? []).map((x) => ({
    value: x.id,
    label: x.name,
  }))

  const onGenerate = () =>
    generate.mutate(
      { workspaceId, contactId, templateId },
      {
        onSuccess: () => toast.success(t("documents.contact.generated")),
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : String(err)),
      },
    )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          items={options}
          onValueChange={(v) => setTemplateId(String(v ?? ""))}
          value={templateId}
        >
          <SelectTrigger
            aria-label={t("documents.contact.selectTemplate")}
            className="w-64 max-w-full"
            data-testid="contact-document-template"
          >
            <SelectValue placeholder={t("documents.contact.selectTemplate")} />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          data-testid="contact-document-generate"
          disabled={templateId === "" || generate.isPending}
          onClick={onGenerate}
          size="sm"
        >
          {generate.isPending ? (
            <Loader2Icon className="me-1 size-4 animate-spin" />
          ) : null}
          {t("actions.generate")}
        </Button>
      </div>
      {options.length === 0 && !templates.isLoading ? (
        <p className="text-muted-foreground text-sm">
          {t("documents.contact.noTemplates")}
        </p>
      ) : null}

      {(documents.data ?? []).length === 0 && !documents.isLoading ? (
        <p className="py-6 text-center text-muted-foreground text-sm">
          {t("documents.contact.empty")}
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {(documents.data ?? []).map((doc) => (
            <li
              className="flex flex-wrap items-center gap-3 px-4 py-3"
              data-testid={`contact-document-${doc.id}`}
              key={doc.id}
            >
              <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-sm">{doc.title}</div>
                <div className="text-muted-foreground text-xs">
                  {format.dateTime(doc.createdAt, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                  {" · "}
                  {t("documents.contact.linkExpires", {
                    date: format.dateTime(doc.linkExpiresAt, {
                      dateStyle: "medium",
                    }),
                  })}
                </div>
              </div>
              <Badge variant={doc.status === "signed" ? "default" : "outline"}>
                {t(statusKey[doc.status])}
              </Badge>
              <Button
                render={
                  // biome-ignore lint/a11y/useAnchorContent: the Button renders its children (icon + label) into this anchor
                  <a
                    href={doc.downloadUrl}
                    rel="noopener noreferrer"
                    target="_blank"
                  />
                }
                size="sm"
                variant="outline"
              >
                <ExternalLinkIcon className="me-1 size-4" />
                {t("documents.contact.open")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
