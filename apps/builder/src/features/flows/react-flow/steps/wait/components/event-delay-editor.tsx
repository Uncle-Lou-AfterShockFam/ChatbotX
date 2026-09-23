"use client"

import {
  delayTypeEventDefaultFn,
  waitStepEventTypes,
} from "@chatbotx.io/flow-config"
import { InputNumberField } from "@chatbotx.io/ui/components/form/input-number-field"
import { SelectField } from "@chatbotx.io/ui/components/form/select-field"
import { Label } from "@chatbotx.io/ui/components/ui/label"
import { useTranslations } from "next-intl"
import { useEffect } from "react"
import { useFormContext, useWatch } from "react-hook-form"
import { CustomFieldSelect } from "@/features/custom-fields/custom-field-select"
import { useTagSelectOptions } from "@/features/tags/provider/tag-hook"
import DelayUnitSelect from "./delay-unit-select"

type EventDelayEditorProps = {
  parentName: string
}

/**
 * `event` wait: park the run until a tag is applied / a custom field changes
 * on the contact, or the timeout fires (the step's success / skip exits).
 */
export function EventDelayEditor({ parentName }: EventDelayEditorProps) {
  const t = useTranslations()
  const { getValues, setValue } = useFormContext()
  const eventType = useWatch({ name: `${parentName}.eventType` })
  const tagOptions = useTagSelectOptions()

  // Switching from another delayType leaves the event fields undefined: seed
  // them once so the schema's defaults hold before the first save.
  useEffect(() => {
    if (getValues(`${parentName}.states`) == null) {
      for (const [key, value] of Object.entries(delayTypeEventDefaultFn())) {
        setValue(`${parentName}.${key}`, value)
      }
    }
  }, [getValues, parentName, setValue])

  const eventTypes = [
    {
      value: waitStepEventTypes.enum.tagApplied,
      label: t("flows.wait.eventTagApplied"),
    },
    {
      value: waitStepEventTypes.enum.customFieldChanged,
      label: t("flows.wait.eventCustomFieldChanged"),
    },
  ]

  return (
    <div className="flex flex-col gap-4">
      <SelectField
        label={t("flows.wait.eventTypeLabel")}
        name={`${parentName}.eventType`}
        options={eventTypes}
      />

      {eventType === waitStepEventTypes.enum.tagApplied && (
        <SelectField
          label={t("flows.wait.eventTagLabel")}
          name={`${parentName}.tagId`}
          options={tagOptions}
        />
      )}

      {eventType === waitStepEventTypes.enum.customFieldChanged && (
        <CustomFieldSelect
          label={t("flows.wait.eventCustomFieldLabel")}
          name={`${parentName}.customFieldId`}
        />
      )}

      <div className="space-y-2">
        <Label className="text-muted-foreground text-xs">
          {t("flows.wait.eventTimeoutLabel")}
        </Label>
        <div className="flex gap-2">
          <InputNumberField
            className="min-w-[80px] flex-1"
            name={`${parentName}.timeoutValue`}
          />
          <DelayUnitSelect name={`${parentName}.timeoutUnit`} />
        </div>
      </div>
    </div>
  )
}
