"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Label } from "@chatbotx.io/ui/components/ui/label"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { toast } from "sonner"
import {
  createOutreachPipelineAction,
  unlinkOutreachPipelineAction,
} from "../actions/outreach-pipeline.action"

/**
 * s228b outreach step 2: the sequence's Outreach pipeline. Classified replies
 * of its contacts open or move a deal there.
 */
export function OutreachPipelineSetting({
  workspaceId,
  sequenceId,
  pipelineId,
}: {
  workspaceId: string
  sequenceId: string
  pipelineId: string | null
}) {
  const t = useTranslations()
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  const run = async (action: "create" | "unlink") => {
    setBusy(true)
    try {
      const result =
        action === "create"
          ? await createOutreachPipelineAction(workspaceId, sequenceId, {})
          : await unlinkOutreachPipelineAction(workspaceId, sequenceId)
      if (result?.serverError || result?.validationErrors) {
        toast.error(result?.serverError ?? t("messages.unknownError"))
        return
      }
      toast.success(t("messages.savedSuccessfully"))
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="flex items-start justify-between gap-4 rounded-lg border px-4 py-3"
      data-testid="sequence-outreach-pipeline"
    >
      <div className="min-w-0 space-y-1">
        <Label>{t("sequences.outreachPipeline")}</Label>
        <p className="text-muted-foreground text-xs">
          {pipelineId
            ? t("sequences.outreachPipelineLinked")
            : t("sequences.outreachPipelineDescription")}
        </p>
      </div>
      {pipelineId ? (
        <div className="flex shrink-0 gap-2">
          <Button
            onClick={() => router.push(`/space/${workspaceId}/deals`)}
            size="sm"
            type="button"
            variant="outline"
          >
            {t("sequences.outreachPipelineOpen")}
          </Button>
          <Button
            disabled={busy}
            onClick={() => run("unlink")}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t("sequences.outreachPipelineUnlink")}
          </Button>
        </div>
      ) : (
        <Button
          className="shrink-0"
          disabled={busy}
          onClick={() => run("create")}
          size="sm"
          type="button"
          variant="outline"
        >
          {t("sequences.outreachPipelineCreate")}
        </Button>
      )}
    </div>
  )
}
