"use client"

import type { ReplyClassManual } from "@chatbotx.io/database/partials"
import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { useTranslations } from "next-intl"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { useWorkspaceId } from "@/hooks/routing"
import {
  classifyReplyAction,
  listReplyClassificationsAction,
} from "./actions/reply-classification.action"

type Classification = {
  id: string
  class: string
  source: string
  reason: string | null
  dealId: string | null
  createdAt: string
}

const MANUAL: ReplyClassManual[] = ["interested", "maybeLater", "notInterested"]

/**
 * s228b outreach step 2: the contact's current reply classification and the
 * operator's three buttons (interested / maybe later / not interested). A
 * sequence with an Outreach pipeline opens or moves the contact's deal.
 */
export function ReplyClassificationControl({
  contactId,
}: {
  contactId: string
}) {
  const t = useTranslations()
  const workspaceId = useWorkspaceId()
  const [latest, setLatest] = useState<Classification | null>(null)
  const [pending, setPending] = useState<ReplyClassManual | null>(null)

  useEffect(() => {
    let live = true
    listReplyClassificationsAction(workspaceId, { contactId })
      .then((result) => {
        if (live) {
          setLatest(result?.data?.[0] ?? null)
        }
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [workspaceId, contactId])

  const classify = async (replyClass: ReplyClassManual) => {
    setPending(replyClass)
    try {
      const result = await classifyReplyAction(workspaceId, {
        contactId,
        class: replyClass,
      })
      if (result?.serverError || !result?.data) {
        toast.error(result?.serverError ?? t("messages.unknownError"))
        return
      }
      setLatest(result.data)
      toast.success(
        result.data.dealId
          ? t("replyClassification.savedDeal")
          : t("replyClassification.saved"),
      )
    } finally {
      setPending(null)
    }
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-md border px-2 py-2 text-xs"
      data-testid="contact-reply-classification"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-muted-foreground">
          {t("replyClassification.title")}
        </span>
        {latest ? (
          <Badge variant={latest.source === "rule" ? "outline" : "secondary"}>
            {t(`replyClassification.class.${latest.class}`)}
          </Badge>
        ) : (
          <span className="text-muted-foreground">
            {t("replyClassification.none")}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {MANUAL.map((replyClass) => (
          <Button
            disabled={pending !== null}
            key={replyClass}
            onClick={() => classify(replyClass)}
            size="sm"
            type="button"
            variant={latest?.class === replyClass ? "default" : "outline"}
          >
            {t(`replyClassification.class.${replyClass}`)}
          </Button>
        ))}
      </div>
    </div>
  )
}
