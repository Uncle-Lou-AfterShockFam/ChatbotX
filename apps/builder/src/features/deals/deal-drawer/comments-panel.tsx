"use client"

import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import { Textarea } from "@chatbotx.io/ui/components/ui/textarea"
import { mentionToken } from "@chatbotx.io/utils/mentions"
import { AtSignIcon, Loader2Icon, SendIcon, TrashIcon } from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { Fragment, useState } from "react"
import {
  createDealCommentAction,
  deleteDealCommentAction,
} from "@/features/deal-comments/actions/deal-comment-actions"
import { useDealComments } from "@/features/deal-comments/provider/deal-comment-hook"
import type { DealCommentResource } from "@/features/deal-comments/schema/resource"
import { onActionError } from "@/features/deal-tasks/lib/on-action-error"

// Same token as `@chatbotx.io/utils/mentions`, split-capable (label, id).
const MENTION_SPLIT = /(@\[[^\]\n]{1,60}\]\(u:\d{1,20}\))/g
const MENTION_PARTS = /^@\[([^\]\n]{1,60})\]\(u:(\d{1,20})\)$/

/** Body text with every mention token rendered as a chip. */
export function CommentBody({ body }: { body: string }) {
  return (
    <span className="whitespace-pre-wrap break-words">
      {body.split(MENTION_SPLIT).map((part, index) => {
        const m = MENTION_PARTS.exec(part)
        const key = `${index}-${part.slice(0, 16)}`
        return m ? (
          <Badge
            className="mx-0.5 align-baseline"
            data-testid="deal-comment-mention"
            key={key}
            variant="secondary"
          >
            @{m[1]}
          </Badge>
        ) : (
          <Fragment key={key}>{part}</Fragment>
        )
      })}
    </span>
  )
}

/**
 * Comments tab of the deal drawer (s193 part 3b): a plain textarea composer
 * with a "Mention" picker that appends an `@[Label](u:<id>)` token (a
 * suggestion popup is not needed for the handful of members a workspace
 * has; the token format is the API contract), and the newest-first list
 * with the tokens rendered as chips. Delete is offered on every row; the
 * server refuses anyone but the author / a super admin.
 */
export function DealCommentsPanel({
  workspaceId,
  dealId,
  ownerOptions,
  onChanged,
}: {
  workspaceId: string
  dealId: string
  ownerOptions: { label: string; value: string }[]
  onChanged: () => void
}) {
  const t = useTranslations()
  const format = useFormatter()
  const comments = useDealComments(workspaceId, dealId)
  const [body, setBody] = useState("")
  const refresh = () => {
    comments.refetch()
    onChanged()
  }
  const create = useAction(createDealCommentAction.bind(null, workspaceId), {
    onSuccess: () => {
      setBody("")
      refresh()
    },
    onError: onActionError,
  })
  const remove = useAction(deleteDealCommentAction.bind(null, workspaceId), {
    onSuccess: refresh,
    onError: onActionError,
  })
  const busy = create.isPending || remove.isPending
  const rows: DealCommentResource[] = comments.data ?? []
  const nameOf = (userId: string | null) =>
    userId
      ? (ownerOptions.find((o) => o.value === userId)?.label ?? userId)
      : t("deals.comments.someone")

  return (
    <div className="space-y-3" data-testid="deal-comments">
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (body.trim()) {
            create.execute({ dealId, body: body.trim() })
          }
        }}
      >
        <Textarea
          aria-label={t("deals.comments.placeholder")}
          data-testid="deal-comment-body"
          maxLength={4000}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t("deals.comments.placeholder")}
          rows={3}
          value={body}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Select
            onValueChange={(userId) => {
              const option = ownerOptions.find((o) => o.value === userId)
              if (option) {
                setBody(
                  (current) =>
                    `${current}${current && !current.endsWith(" ") ? " " : ""}${mentionToken({ userId: option.value, label: option.label })} `,
                )
              }
            }}
            value=""
          >
            <SelectTrigger
              className="w-44"
              data-testid="deal-comment-mention-pick"
            >
              <SelectValue placeholder={t("deals.comments.mention")}>
                <span className="flex items-center gap-1">
                  <AtSignIcon className="size-4" />
                  {t("deals.comments.mention")}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {ownerOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            className="ml-auto"
            data-testid="deal-comment-post"
            disabled={busy || body.trim().length === 0}
            size="sm"
            type="submit"
          >
            {create.isPending ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <SendIcon />
            )}
            {t("deals.comments.post")}
          </Button>
        </div>
      </form>

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {t("deals.comments.none")}
        </p>
      ) : null}
      <ul className="space-y-3 text-sm">
        {rows.map((comment) => (
          <li
            className="rounded-md border p-2"
            data-testid={`deal-comment-${comment.id}`}
            key={comment.id}
          >
            <div className="mb-1 flex items-center gap-2 text-muted-foreground text-xs">
              <span className="font-medium text-foreground">
                {nameOf(comment.authorId)}
              </span>
              <span>
                {format.dateTime(new Date(comment.createdAt), {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </span>
              {comment.editedAt ? (
                <span>{t("deals.comments.edited")}</span>
              ) : null}
              <Button
                aria-label={t("actions.delete")}
                className="ml-auto"
                disabled={busy}
                onClick={() =>
                  remove.execute({ dealId, commentId: comment.id })
                }
                size="icon"
                type="button"
                variant="ghost"
              >
                <TrashIcon className="size-4" />
              </Button>
            </div>
            <CommentBody body={comment.body} />
          </li>
        ))}
      </ul>
    </div>
  )
}
