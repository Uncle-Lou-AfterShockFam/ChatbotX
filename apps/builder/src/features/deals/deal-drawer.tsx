"use client"

import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import { Separator } from "@chatbotx.io/ui/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@chatbotx.io/ui/components/ui/sheet"
import { Textarea } from "@chatbotx.io/ui/components/ui/textarea"
import {
  Loader2Icon,
  RotateCcwIcon,
  ThumbsDownIcon,
  TrashIcon,
  TrophyIcon,
} from "lucide-react"
import Link from "next/link"
import { useFormatter, useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { ConfirmButton } from "@/components/confirm-button"
import type { PipelineWithStagesResource } from "@/features/pipelines/schema/resource"
import { addDealNoteAction } from "./actions/add-deal-note-action"
import { deleteDealsAction } from "./actions/delete-deals-action"
import { moveDealAction } from "./actions/move-deal-action"
import { setDealStatusAction } from "./actions/set-deal-status-action"
import { updateDealAction } from "./actions/update-deal-action"
import { formatDealValue } from "./deal-card"
import { useDealActivities, useOwnerOptions } from "./provider/deal-hook"
import type { DealActivityResource, DealResource } from "./schema/resource"

const onActionError = ({ error }: { error: { serverError?: string } }) => {
  if (error.serverError) {
    toast.error(error.serverError)
  }
}

function describeActivity(
  activity: DealActivityResource,
  stageNames: Map<string, string>,
  t: ReturnType<typeof useTranslations>,
): string {
  const p = activity.payload as Record<string, unknown>
  switch (activity.type) {
    case "created":
      return t("deals.activity.created", {
        stage: stageNames.get(String(p.stageId)) ?? String(p.stageId ?? ""),
      })
    case "stageMoved":
      return t("deals.activity.stageMoved", {
        from: stageNames.get(String(p.from)) ?? String(p.from ?? ""),
        to: stageNames.get(String(p.to)) ?? String(p.to ?? ""),
      })
    case "valueChanged":
      return t("deals.activity.valueChanged", {
        from: String(p.from ?? "-"),
        to: String(p.to ?? "-"),
      })
    case "statusChanged":
      return t("deals.activity.statusChanged", {
        from: String(p.from ?? ""),
        to: String(p.to ?? ""),
      })
    case "priorityChanged":
      return t("deals.activity.priorityChanged", {
        from: String(p.from ?? ""),
        to: String(p.to ?? ""),
      })
    case "assigned":
      return t("deals.activity.assigned")
    case "note":
      return String(p.text ?? "")
    default:
      return activity.type
  }
}

export function DealDrawer({
  workspaceId,
  deal,
  pipeline,
  onOpenChange,
  onChanged,
}: {
  workspaceId: string
  deal: DealResource | null
  pipeline: PipelineWithStagesResource | null
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}) {
  const t = useTranslations()
  const format = useFormatter()
  const open = deal !== null
  const ownerOptions = useOwnerOptions(workspaceId, { enabled: open })
  const activities = useDealActivities(workspaceId, deal?.id)
  const stageNames = new Map(
    (pipeline?.stages ?? []).map((s) => [s.id, s.name] as const),
  )

  const [title, setTitle] = useState("")
  const [value, setValue] = useState("")
  const [note, setNote] = useState("")
  useEffect(() => {
    setTitle(deal?.title ?? "")
    setValue(deal?.value ?? "")
    setNote("")
  }, [deal?.title, deal?.value])

  const refresh = () => {
    onChanged()
    activities.refetch()
  }
  const update = useAction(updateDealAction.bind(null, workspaceId), {
    onSuccess: refresh,
    onError: onActionError,
  })
  const move = useAction(moveDealAction.bind(null, workspaceId), {
    onSuccess: refresh,
    onError: onActionError,
  })
  const setStatus = useAction(setDealStatusAction.bind(null, workspaceId), {
    onSuccess: refresh,
    onError: onActionError,
  })
  const addNote = useAction(addDealNoteAction.bind(null, workspaceId), {
    onSuccess: () => {
      setNote("")
      refresh()
    },
    onError: onActionError,
  })
  const remove = useAction(deleteDealsAction.bind(null, workspaceId), {
    onSuccess: () => {
      toast.success(t("messages.deletedSuccess", { feature: t("deals.one") }))
      onOpenChange(false)
      onChanged()
    },
    onError: onActionError,
  })
  const busy =
    update.isPending ||
    move.isPending ||
    setStatus.isPending ||
    addNote.isPending ||
    remove.isPending

  if (!deal) {
    return <Sheet onOpenChange={onOpenChange} open={false} />
  }
  const id = deal.id

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent
        className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-lg"
        data-testid="deal-drawer"
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Input
              aria-label={t("deals.fields.title")}
              className="font-semibold"
              data-testid="deal-title"
              onBlur={() => {
                const next = title.trim()
                if (next && next !== deal.title) {
                  update.execute({ id, title: next })
                }
              }}
              onChange={(e) => setTitle(e.target.value)}
              value={title}
            />
            <Badge variant={deal.status === "won" ? "default" : "secondary"}>
              {t(`deals.statuses.${deal.status}`)}
            </Badge>
          </SheetTitle>
          <SheetDescription>
            {pipeline?.name} / {stageNames.get(deal.stageId) ?? deal.stageId}
          </SheetDescription>
        </SheetHeader>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="space-y-1">
            <span className="text-muted-foreground text-xs">
              {t("deals.fields.value")}
            </span>
            <Input
              data-testid="deal-value"
              onBlur={() => {
                if (value !== (deal.value ?? "")) {
                  update.execute({ id, value: value === "" ? null : value })
                }
              }}
              onChange={(e) => setValue(e.target.value)}
              placeholder="0.00"
              value={value}
            />
            <span className="text-muted-foreground text-xs">
              {formatDealValue(deal.value, deal.currency, format) ?? "-"}
            </span>
          </div>
          <div className="space-y-1">
            <span className="text-muted-foreground text-xs">
              {t("deals.fields.priority")}
            </span>
            <Select
              onValueChange={(next) =>
                next &&
                next !== deal.priority &&
                update.execute({
                  id,
                  priority: next as DealResource["priority"],
                })
              }
              value={deal.priority}
            >
              <SelectTrigger data-testid="deal-priority">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["low", "medium", "high"] as const).map((p) => (
                  <SelectItem key={p} value={p}>
                    {t(`deals.priorities.${p}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <span className="text-muted-foreground text-xs">
              {t("deals.stage")}
            </span>
            <Select
              onValueChange={(next) => {
                const stageId = String(next ?? "")
                if (stageId && stageId !== deal.stageId) {
                  move.execute({ id, stageId })
                }
              }}
              value={deal.stageId}
            >
              <SelectTrigger data-testid="deal-stage">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(pipeline?.stages ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <span className="text-muted-foreground text-xs">
              {t("deals.fields.owner")}
            </span>
            <Select
              onValueChange={(next) => {
                const ownerId = String(next ?? "")
                update.execute({
                  id,
                  ownerId: ownerId === "__none" ? null : ownerId,
                })
              }}
              value={deal.ownerId ?? "__none"}
            >
              <SelectTrigger data-testid="deal-owner">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">{t("deals.noOwner")}</SelectItem>
                {ownerOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1 text-sm">
          <div className="text-muted-foreground text-xs">
            {t("deals.fields.contact")}
          </div>
          {deal.contactId ? (
            // The hub has no per-contact route (contacts open inside the list
            // panel), so the link lands on the contacts list; the id is shown
            // so it can be searched for.
            <Link
              className="hover:underline"
              href={`/space/${workspaceId}/contacts`}
            >
              {t("deals.openContact")} ({deal.contactId})
            </Link>
          ) : (
            <span className="text-muted-foreground">
              {t("deals.noContact")}
            </span>
          )}
          {deal.companyId ? (
            <Link
              className="block hover:underline"
              href={`/space/${workspaceId}/companies/${deal.companyId}`}
            >
              {t("deals.openCompany")}
            </Link>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          {deal.status === "open" ? (
            <>
              <Button
                data-testid="deal-won"
                disabled={busy}
                onClick={() => setStatus.execute({ id, status: "won" })}
                size="sm"
              >
                <TrophyIcon />
                {t("deals.markWon")}
              </Button>
              <Button
                data-testid="deal-lost"
                disabled={busy}
                onClick={() => setStatus.execute({ id, status: "lost" })}
                size="sm"
                variant="outline"
              >
                <ThumbsDownIcon />
                {t("deals.markLost")}
              </Button>
            </>
          ) : (
            <Button
              data-testid="deal-reopen"
              disabled={busy}
              onClick={() => setStatus.execute({ id, status: "open" })}
              size="sm"
              variant="outline"
            >
              <RotateCcwIcon />
              {t("deals.reopen")}
            </Button>
          )}
          <ConfirmButton
            className="ml-auto"
            data-testid="deal-delete"
            description={t("deals.deleteConfirm")}
            disabled={busy}
            onConfirm={() => remove.execute({ ids: [id] })}
            size="sm"
            title={t("messages.deleteFeature", { feature: t("deals.one") })}
            variant="destructive"
          >
            <TrashIcon />
            {t("actions.delete")}
          </ConfirmButton>
        </div>

        <Separator />

        <div className="space-y-2">
          <div className="font-medium text-sm">{t("deals.activityTitle")}</div>
          <div className="flex gap-2">
            <Textarea
              data-testid="deal-note"
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("deals.notePlaceholder")}
              rows={2}
              value={note}
            />
            <Button
              disabled={busy || note.trim().length === 0}
              onClick={() => addNote.execute({ id, text: note })}
              size="sm"
            >
              {addNote.isPending ? (
                <Loader2Icon className="animate-spin" />
              ) : null}
              {t("deals.addNote")}
            </Button>
          </div>
          <ul className="space-y-2 text-sm" data-testid="deal-activities">
            {(activities.data ?? []).map((activity) => (
              <li className="rounded-md border p-2" key={activity.id}>
                <div className="text-muted-foreground text-xs">
                  {format.dateTime(activity.createdAt, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                  {" · "}
                  {t(`deals.activity.types.${activity.type}`)}
                </div>
                <div className="whitespace-pre-wrap">
                  {describeActivity(activity, stageNames, t)}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </SheetContent>
    </Sheet>
  )
}
