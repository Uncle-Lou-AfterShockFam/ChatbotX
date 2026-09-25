import {
  type TriggerEventType,
  triggerEventTypes,
} from "@chatbotx.io/database/partials"
import { ComboboxField } from "@chatbotx.io/ui/components/form/combobox-field"
import { InputField } from "@chatbotx.io/ui/components/form/input-field"
import { SelectField } from "@chatbotx.io/ui/components/form/select-field"
import { useTranslations } from "next-intl"
import { useMemo } from "react"
import { useFormContext } from "react-hook-form"
import { getContactInfoTypeOptions } from "@/features/contact-filter/components/contact-filter-config"
import { useFormOptions } from "@/features/forms/provider/form-hooks"
import {
  usePipelineOptions,
  useStageOptionsGroupedByPipeline,
} from "@/features/pipelines/provider/pipeline-hook"
import { useSequenceOptions } from "@/features/sequences/provider/sequence-hook"
import { useTagSelectOptions } from "@/features/tags/provider/tag-hook"
import { CustomFieldValueChanged } from "./custom-field-value-changed"
import { DateTimeBasedTrigger } from "./date-time-based-trigger"

export const ConditionEditor = ({
  parentName,
  type,
}: {
  parentName: string
  type: TriggerEventType
}) => {
  const t = useTranslations()
  const tagOptions = useTagSelectOptions()
  const contactInfoTypeOptions = useMemo(
    () => getContactInfoTypeOptions(t),
    [t],
  )
  const sequences = useSequenceOptions()
  const sequenceOptions = useMemo(
    () =>
      sequences.map((sequence) => ({
        label: sequence.name,
        value: sequence.id,
      })),
    [sequences],
  )
  const pipelineOptions = usePipelineOptions()
  const formOptions = useFormOptions()
  const stageOptions = useStageOptionsGroupedByPipeline()
  const form = useFormContext()

  switch (type) {
    case triggerEventTypes.enum.tagApplied:
    case triggerEventTypes.enum.tagRemoved: {
      return (
        <ComboboxField
          emptyText={t("actions.noRecordFound")}
          name={`${parentName}.sourceId`}
          options={tagOptions}
          placeholder={t("actions.pleaseSelect")}
          popoverClassName="w-[var(--anchor-width)]"
        />
      )
    }
    case triggerEventTypes.enum.contactInfoUpdated:
      return (
        <SelectField
          name={`${parentName}.sourceId`}
          options={contactInfoTypeOptions}
        />
      )
    case triggerEventTypes.enum.subscribedToSequence:
    case triggerEventTypes.enum.unsubscribedFromSequence:
      return (
        <ComboboxField
          emptyText={t("actions.noRecordFound")}
          name={`${parentName}.sourceId`}
          options={sequenceOptions}
          placeholder={t("actions.pleaseSelect")}
          popoverClassName="w-[var(--anchor-width)]"
        />
      )
    // Deal conditions: pinned to a pipeline, or to the destination stage for a move.
    case triggerEventTypes.enum.ticketCreated:
    case triggerEventTypes.enum.ticketValueChanged:
    case triggerEventTypes.enum.ticketStatusChanged:
    case triggerEventTypes.enum.ticketPriorityChanged:
    case triggerEventTypes.enum.taskCreated:
    case triggerEventTypes.enum.taskCompleted:
    case triggerEventTypes.enum.taskOverdue:
    case triggerEventTypes.enum.taskAssigned:
    case triggerEventTypes.enum.dealMentioned:
      return (
        <ComboboxField
          emptyText={t("deals.noPipelines")}
          name={`${parentName}.sourceId`}
          options={pipelineOptions}
          placeholder={t("deals.pipeline")}
          popoverClassName="w-[var(--anchor-width)]"
        />
      )
    case triggerEventTypes.enum.formSubmitted:
      return (
        <ComboboxField
          emptyText={t("forms.empty")}
          name={`${parentName}.sourceId`}
          options={formOptions}
          placeholder={t("forms.singular")}
          popoverClassName="w-[var(--anchor-width)]"
        />
      )
    case triggerEventTypes.enum.ticketMovedToStage:
      return (
        <ComboboxField
          emptyText={t("deals.noPipelines")}
          name={`${parentName}.sourceId`}
          options={stageOptions}
          placeholder={t("deals.stage")}
          popoverClassName="w-[var(--anchor-width)]"
        />
      )
    case triggerEventTypes.enum.dateTimeBasedTrigger:
      return <DateTimeBasedTrigger parentName={parentName} />
    case triggerEventTypes.enum.customFieldValueChanged:
      return <CustomFieldValueChanged parentName={parentName} />
    default:
      return (
        <>
          <InputField type="hidden" {...form.register(`${parentName}.id`)} />
          <InputField type="hidden" {...form.register(`${parentName}.type`)} />
          <InputField
            type="hidden"
            {...form.register(`${parentName}.sourceId`)}
          />
          <InputField
            type="hidden"
            {...form.register(`${parentName}.operator`)}
          />
          <InputField type="hidden" {...form.register(`${parentName}.value`)} />
        </>
      )
  }
}
