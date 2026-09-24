"use client"

import { ComboboxField } from "@chatbotx.io/ui/components/form/combobox-field"
import { useTranslations } from "next-intl"
import { useWatch } from "react-hook-form"
import { useTaskTemplateOptions } from "@/features/deal-tasks/provider/deal-task-hook"
import {
  usePipelineOptions,
  useStageOptions,
} from "@/features/pipelines/provider/pipeline-hook"
import { useWorkspaceId } from "@/hooks/routing"

/** Pipeline combobox shared by the three deal steps. */
export const PipelinePicker = ({ parentName }: { parentName: string }) => {
  const t = useTranslations()
  const options = usePipelineOptions()
  return (
    <ComboboxField
      emptyText={t("deals.noPipelines")}
      label={t("deals.pipeline")}
      name={`${parentName}.pipelineId`}
      options={options}
      placeholder={t("actions.pleaseSelect")}
      popoverClassName="w-[var(--anchor-width)]"
    />
  )
}

/**
 * Optional destination pipeline of the moveDealStage step (s196): cleared =
 * the deal stays in its pipeline.
 */
export const TargetPipelinePicker = ({
  parentName,
}: {
  parentName: string
}) => {
  const t = useTranslations()
  const options = usePipelineOptions()
  return (
    <ComboboxField
      allowClear
      clearLabel={t("deals.movePipeline.samePipeline")}
      emptyText={t("deals.noPipelines")}
      label={t("deals.movePipeline.targetPipeline")}
      name={`${parentName}.targetPipelineId`}
      options={options}
      placeholder={t("deals.movePipeline.samePipeline")}
      popoverClassName="w-[var(--anchor-width)]"
    />
  )
}

/**
 * Stage combobox filtered to the pipeline picked next to it, or to the
 * destination pipeline when `followTarget` and one is picked (s196).
 */
export const StagePicker = ({
  parentName,
  allowClear,
  clearLabel,
  followTarget,
}: {
  parentName: string
  allowClear?: boolean
  clearLabel?: string
  followTarget?: boolean
}) => {
  const t = useTranslations()
  const [sourceId, targetId] = useWatch({
    name: [`${parentName}.pipelineId`, `${parentName}.targetPipelineId`],
  }) as [string | undefined, string | undefined]
  const pipelineId = (followTarget && targetId) || sourceId
  const options = useStageOptions(pipelineId)
  return (
    <ComboboxField
      allowClear={allowClear}
      clearLabel={clearLabel}
      emptyText={
        pipelineId ? t("actions.noRecordFound") : t("deals.pickPipelineFirst")
      }
      label={t("deals.stage")}
      name={`${parentName}.stageId`}
      options={options}
      placeholder={t("actions.pleaseSelect")}
      popoverClassName="w-[var(--anchor-width)]"
    />
  )
}

/** Task-template combobox filtered to the pipeline picked next to it (completeTask step). */
export const TaskTemplatePicker = ({ parentName }: { parentName: string }) => {
  const t = useTranslations()
  const workspaceId = useWorkspaceId()
  const pipelineId = useWatch({ name: `${parentName}.pipelineId` }) as
    | string
    | undefined
  const options = useTaskTemplateOptions(workspaceId ?? "", pipelineId)
  return (
    <ComboboxField
      emptyText={
        pipelineId
          ? t("deals.taskTemplates.none")
          : t("deals.pickPipelineFirst")
      }
      label={t("deals.taskTemplates.one")}
      name={`${parentName}.templateId`}
      options={options}
      placeholder={t("actions.pleaseSelect")}
      popoverClassName="w-[var(--anchor-width)]"
    />
  )
}
