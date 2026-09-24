"use client"

import { ComboboxField } from "@chatbotx.io/ui/components/form/combobox-field"
import { SelectField } from "@chatbotx.io/ui/components/form/select-field"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@chatbotx.io/ui/components/ui/dialog"
import { Form } from "@chatbotx.io/ui/components/ui/form"
import { useQuery } from "@tanstack/react-query"
import { ArrowRightLeftIcon, Loader2Icon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useMemo, useState } from "react"
import { useForm, useWatch } from "react-hook-form"
import { toast } from "sonner"
import { usePipelines } from "@/features/pipelines/provider/pipeline-hook"
import { orpc } from "@/lib/orpc/query"
import { moveDealPipelineAction } from "../actions/move-deal-pipeline-action"
import { DealCustomFieldsGrid } from "../deal-field-input"
import {
  buildMovePipelineInput,
  fieldsNeedingInput,
  movePipelineOwnerOptions,
} from "../lib/move-pipeline"
import type { DealResource } from "../schema/resource"

type FormValues = { pipelineId: string; stageId: string; ownerId: string }

/**
 * s196: move the deal to ANOTHER pipeline. Asks for the destination stage
 * (default: its first), every destination field the deal's current values do
 * not satisfy, and a new owner when the destination is members-only. The
 * server re-checks all of it; its 422 (owner not a member, an open deal
 * already there) is the toast.
 */
export function MovePipelineDialog({
  workspaceId,
  deal,
  ownerOptions,
  disabled,
  onMoved,
}: {
  workspaceId: string
  deal: DealResource
  ownerOptions: { label: string; value: string }[]
  disabled?: boolean
  onMoved: (pipelineId: string) => void
}) {
  const t = useTranslations()
  const [open, setOpen] = useState(false)
  const [fields, setFields] = useState<Record<string, unknown>>({})
  const pipelines = usePipelines(workspaceId, { enabled: open })
  const targets = useMemo(
    () => (pipelines.data ?? []).filter((p) => p.id !== deal.pipelineId),
    [pipelines.data, deal.pipelineId],
  )

  const form = useForm<FormValues>({
    defaultValues: { pipelineId: "", stageId: "", ownerId: deal.ownerId ?? "" },
  })
  const pipelineId = useWatch({ control: form.control, name: "pipelineId" })
  const target = targets.find((p) => p.id === pipelineId)
  const members = useQuery(
    orpc.pipelinesAPI.privateListPipelineMembersAPI.queryOptions({
      input: { workspaceId, id: pipelineId },
      enabled: target?.settings.access === "members",
      select: (res) => res.data.map((m) => m.userId),
    }),
  )
  const needed = target
    ? fieldsNeedingInput(target.settings.fieldDefs, deal.fields)
    : []
  const owners = target
    ? movePipelineOwnerOptions({
        access: target.settings.access,
        memberIds: members.data ?? [],
        ownerOptions,
        currentOwnerId: deal.ownerId,
      })
    : ownerOptions

  const { execute, isPending } = useAction(
    moveDealPipelineAction.bind(null, workspaceId),
    {
      onSuccess: ({ input }) => {
        toast.success(
          t("deals.movePipeline.moved", { pipeline: target?.name ?? "" }),
        )
        setOpen(false)
        onMoved(input.pipelineId)
      },
      onError: ({ error }) => {
        if (error.serverError) {
          toast.error(error.serverError)
        }
      },
    },
  )

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) {
      form.reset({ pipelineId: "", stageId: "", ownerId: deal.ownerId ?? "" })
      setFields({})
    }
  }

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogTrigger
        render={
          <Button
            data-testid="deal-move-pipeline"
            disabled={disabled}
            size="sm"
            variant="outline"
          >
            <ArrowRightLeftIcon />
            {t("deals.movePipeline.action")}
          </Button>
        }
      />
      <DialogContent
        className="max-h-screen max-w-lg overflow-y-auto"
        data-testid="deal-move-pipeline-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t("deals.movePipeline.title")}</DialogTitle>
          <DialogDescription>
            {t("deals.movePipeline.description")}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="space-y-5"
            onSubmit={form.handleSubmit((values) =>
              execute(
                buildMovePipelineInput({
                  id: deal.id,
                  pipelineId: values.pipelineId,
                  stageId: values.stageId,
                  ownerId: values.ownerId,
                  currentOwnerId: deal.ownerId,
                  fields,
                }),
              ),
            )}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <SelectField
                label={t("deals.movePipeline.targetPipeline")}
                name="pipelineId"
                options={targets.map((p) => ({ label: p.name, value: p.id }))}
                placeholder={t("actions.pleaseSelect")}
                required
                triggerValueChange={() => {
                  form.setValue("stageId", "")
                  setFields({})
                }}
              />
              <SelectField
                label={t("deals.stage")}
                name="stageId"
                options={(target?.stages ?? []).map((s) => ({
                  label: s.name,
                  value: s.id,
                }))}
                placeholder={t("deals.firstStage")}
              />
            </div>
            {target ? (
              <ComboboxField
                allowClear
                clearLabel={t("deals.noOwner")}
                description={
                  target.settings.access === "members"
                    ? t("deals.movePipeline.ownerMembersOnly")
                    : undefined
                }
                emptyText={t("actions.noRecordFound")}
                label={t("deals.fields.owner")}
                name="ownerId"
                options={owners}
                portal
              />
            ) : null}
            <DealCustomFieldsGrid
              fieldDefs={needed}
              onCommit={(key, next) =>
                setFields((prev) => ({ ...prev, [key]: next }))
              }
              testIdPrefix="deal-move-field"
              values={{ ...deal.fields, ...fields }}
            />
            <DialogFooter>
              <DialogClose
                render={
                  <Button size="sm" type="button" variant="ghost">
                    {t("actions.cancel")}
                  </Button>
                }
              />
              <Button
                data-testid="deal-move-pipeline-confirm"
                disabled={!pipelineId || isPending}
                size="sm"
                type="submit"
              >
                {isPending && <Loader2Icon className="animate-spin" />}
                {t("deals.movePipeline.confirm")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
