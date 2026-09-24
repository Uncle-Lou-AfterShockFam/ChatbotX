"use client"

import { MAX_PIPELINE_MEMBERS } from "@chatbotx.io/database/partials"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import { Switch } from "@chatbotx.io/ui/components/ui/switch"
import { useQuery } from "@tanstack/react-query"
import { PlusIcon, TrashIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useState } from "react"
import { toast } from "sonner"
import { useOwnerOptions } from "@/features/deals/provider/deal-hook"
import { orpc } from "@/lib/orpc/query"
import { setPipelineMembersAction } from "./actions/pipeline-actions"
import { useInvalidatePipelines } from "./provider/pipeline-hook"

type Row = { userId: string; inRotation: boolean }

/**
 * Per-pipeline member list (s193): who a `members`-only pipeline is visible
 * to and, via `inRotation`, who round-robin assignment may pick. Every save
 * REPLACES the list in the given order; the server validates membership.
 */
export function PipelineMembersEditor({
  workspaceId,
  pipelineId,
}: {
  workspaceId: string
  pipelineId: string
}) {
  const t = useTranslations()
  const invalidate = useInvalidatePipelines()
  const ownerOptions = useOwnerOptions(workspaceId)
  const { data: members } = useQuery(
    orpc.pipelinesAPI.privateListPipelineMembersAPI.queryOptions({
      input: { workspaceId, id: pipelineId },
      select: (res) => res.data,
    }),
  )
  const [rows, setRows] = useState<Row[] | null>(null)
  const [synced, setSynced] = useState(members)
  if (synced !== members) {
    setSynced(members)
    setRows(null)
  }
  const current: Row[] =
    rows ??
    (members ?? []).map((m) => ({ userId: m.userId, inRotation: m.inRotation }))
  const dirty = rows !== null

  const save = useAction(setPipelineMembersAction.bind(null, workspaceId), {
    onSuccess: () => {
      setRows(null)
      invalidate()
    },
    onError: ({ error }) => {
      if (error.serverError) {
        toast.error(error.serverError)
      }
    },
  })

  const labelOf = (userId: string) =>
    ownerOptions.find((o) => o.value === userId)?.label ?? userId
  const remaining = ownerOptions.filter(
    (o) => !current.some((r) => r.userId === o.value),
  )

  return (
    <div className="space-y-2" data-testid={`pipeline-members-${pipelineId}`}>
      <div className="font-medium text-sm">{t("deals.members.title")}</div>
      <p className="text-muted-foreground text-xs">{t("deals.members.hint")}</p>
      {current.length === 0 && (
        <p className="text-muted-foreground text-xs">
          {t("deals.members.none")}
        </p>
      )}
      <ul className="space-y-1">
        {current.map((row) => (
          <li className="flex items-center gap-3 text-sm" key={row.userId}>
            <span className="min-w-40 flex-1">{labelOf(row.userId)}</span>
            <span className="flex items-center gap-2 text-muted-foreground text-xs">
              <Switch
                aria-label={t("deals.members.inRotation")}
                checked={row.inRotation}
                onCheckedChange={(checked) =>
                  setRows(
                    current.map((r) =>
                      r.userId === row.userId
                        ? { ...r, inRotation: checked }
                        : r,
                    ),
                  )
                }
              />
              {t("deals.members.inRotation")}
            </span>
            <Button
              aria-label={t("deals.members.remove")}
              onClick={() =>
                setRows(current.filter((r) => r.userId !== row.userId))
              }
              size="icon"
              type="button"
              variant="ghost"
            >
              <TrashIcon className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {remaining.length > 0 && current.length < MAX_PIPELINE_MEMBERS && (
          <Select
            onValueChange={(userId) =>
              typeof userId === "string" &&
              userId &&
              setRows([...current, { userId, inRotation: true }])
            }
            value=""
          >
            <SelectTrigger
              className="w-56"
              data-testid={`pipeline-members-add-${pipelineId}`}
            >
              <SelectValue placeholder={t("deals.members.add")}>
                <span className="flex items-center gap-1">
                  <PlusIcon className="size-4" />
                  {t("deals.members.add")}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {remaining.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {dirty && (
          <Button
            data-testid={`pipeline-members-save-${pipelineId}`}
            disabled={save.isPending}
            onClick={() => save.execute({ pipelineId, members: current })}
            size="sm"
            type="button"
          >
            {t("actions.save")}
          </Button>
        )}
      </div>
    </div>
  )
}
