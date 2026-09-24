"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { ExternalLinkIcon, Loader2Icon } from "lucide-react"
import Link from "next/link"
import { useFormatter, useTranslations } from "next-intl"
import { useState } from "react"
import { useMessages } from "../provider/crm-hooks"

/**
 * Read-only view of a contact's DM conversation (s195): newest page first,
 * "load older" walks the cursor. No composer: sends stay in the inbox and the
 * flows so the send gates are never bypassed from a CRM page.
 */
export function ConversationMessages({
  workspaceId,
  conversationId,
}: {
  workspaceId: string
  conversationId: string | null
}) {
  const t = useTranslations()
  const format = useFormatter()
  const [cursors, setCursors] = useState<(string | null)[]>([null])
  const pages = cursors.map((cursor) => ({
    cursor,
    // biome-ignore lint/correctness/useHookAtTopLevel: the cursor list only grows (append-only), so hook order is stable
    query: useMessages(workspaceId, conversationId, cursor),
  }))
  if (!conversationId) {
    return (
      <p className="text-muted-foreground text-sm">{t("crm.noConversation")}</p>
    )
  }
  const rows = pages.flatMap((p) => p.query.data?.data ?? [])
  const loading = pages.some((p) => p.query.isLoading)
  const nextCursor = pages.at(-1)?.query.data?.nextCursor ?? null
  return (
    <div className="space-y-3" data-testid="crm-conversation">
      <Button
        render={
          <Link
            href={`/space/${workspaceId}/inbox?conversationId=${conversationId}`}
          />
        }
        size="sm"
        variant="outline"
      >
        <ExternalLinkIcon className="me-2 size-4" />
        {t("crm.openInInbox")}
      </Button>
      {rows.length === 0 && !loading ? (
        <p className="text-muted-foreground text-sm">{t("crm.noMessages")}</p>
      ) : (
        <ol className="space-y-2">
          {rows.map((message) => {
            const incoming = message.messageType === "incoming"
            return (
              <li
                className={`flex ${incoming ? "justify-start" : "justify-end"}`}
                data-testid="crm-message"
                key={message.id}
              >
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${incoming ? "bg-muted" : "bg-primary text-primary-foreground"}`}
                >
                  <div className="whitespace-pre-wrap break-words">
                    {message.text ??
                      (message.attachments.length > 0
                        ? t("crm.attachment")
                        : t("crm.emptyMessage"))}
                  </div>
                  <div className="mt-1 text-[11px] opacity-70">
                    {format.dateTime(new Date(message.createdAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      )}
      {loading ? (
        <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
      ) : null}
      {!loading && nextCursor && !cursors.includes(nextCursor) ? (
        <Button
          onClick={() => setCursors([...cursors, nextCursor])}
          size="sm"
          variant="outline"
        >
          {t("crm.loadOlder")}
        </Button>
      ) : null}
    </div>
  )
}
