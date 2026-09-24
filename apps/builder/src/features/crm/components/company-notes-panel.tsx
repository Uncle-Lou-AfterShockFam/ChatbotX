"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Textarea } from "@chatbotx.io/ui/components/ui/textarea"
import { Loader2Icon, PencilIcon, TrashIcon } from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import { useState } from "react"
import { toast } from "sonner"
import { ConfirmButton } from "@/components/confirm-button"
import { client } from "@/lib/orpc/orpc"
import { useCompanyNotes, useInvalidateCrm } from "../provider/crm-hooks"
import type { CompanyNoteResource } from "../schema/resource"

/** Company notes (s195): add, edit in place, delete with confirmation. */
export function CompanyNotesPanel({
  workspaceId,
  companyId,
  memberNames,
}: {
  workspaceId: string
  companyId: string
  memberNames: Map<string, string>
}) {
  const t = useTranslations()
  const format = useFormatter()
  const notes = useCompanyNotes(workspaceId, companyId)
  const invalidate = useInvalidateCrm()
  const [draft, setDraft] = useState("")
  const [editing, setEditing] = useState<CompanyNoteResource | null>(null)
  const [editText, setEditText] = useState("")
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
      await invalidate()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const rows = notes.data ?? []
  return (
    <div className="space-y-3" data-testid="company-notes">
      <div className="space-y-2">
        <Textarea
          aria-label={t("crm.addNote")}
          data-testid="company-note-input"
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("crm.notePlaceholder")}
          rows={3}
          value={draft}
        />
        <Button
          data-testid="company-note-add"
          disabled={busy || draft.trim().length === 0}
          onClick={() =>
            run(async () => {
              await client.crmAPI.privateCreateCompanyNoteAPI({
                workspaceId,
                id: companyId,
                text: draft,
              })
              setDraft("")
            })
          }
          size="sm"
        >
          {busy ? <Loader2Icon className="me-2 size-4 animate-spin" /> : null}
          {t("crm.addNote")}
        </Button>
      </div>
      {rows.length === 0 && !notes.isLoading ? (
        <p className="text-muted-foreground text-sm">{t("crm.noNotes")}</p>
      ) : (
        <ul className="divide-y">
          {rows.map((note) => (
            <li
              className="py-2 text-sm"
              data-testid="company-note"
              key={note.id}
            >
              {editing?.id === note.id ? (
                <div className="space-y-2">
                  <Textarea
                    onChange={(e) => setEditText(e.target.value)}
                    rows={3}
                    value={editText}
                  />
                  <div className="flex gap-2">
                    <Button
                      disabled={busy || editText.trim().length === 0}
                      onClick={() =>
                        run(async () => {
                          await client.crmAPI.privateUpdateCompanyNoteAPI({
                            workspaceId,
                            id: companyId,
                            noteId: note.id,
                            text: editText,
                          })
                          setEditing(null)
                        })
                      }
                      size="sm"
                    >
                      {t("actions.save")}
                    </Button>
                    <Button
                      onClick={() => setEditing(null)}
                      size="sm"
                      variant="ghost"
                    >
                      {t("actions.cancel")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="whitespace-pre-wrap break-words">
                      {note.text}
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {[
                        note.createdById
                          ? memberNames.get(note.createdById)
                          : null,
                        format.dateTime(new Date(note.createdAt), {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  <Button
                    aria-label={t("actions.edit")}
                    onClick={() => {
                      setEditing(note)
                      setEditText(note.text)
                    }}
                    size="icon"
                    variant="ghost"
                  >
                    <PencilIcon className="size-3" />
                  </Button>
                  <ConfirmButton
                    aria-label={t("crm.deleteNote")}
                    description={t("crm.deleteNote")}
                    disabled={busy}
                    onConfirm={() =>
                      run(() =>
                        client.crmAPI.privateDeleteCompanyNoteAPI({
                          workspaceId,
                          id: companyId,
                          noteId: note.id,
                        }),
                      )
                    }
                    size="icon"
                    title={t("crm.deleteNote")}
                    variant="ghost"
                  >
                    <TrashIcon className="size-3" />
                  </ConfirmButton>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
