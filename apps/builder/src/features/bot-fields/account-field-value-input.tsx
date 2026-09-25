"use client"

import type { CustomFieldType } from "@chatbotx.io/database/partials"
import {
  DatePickerField,
  DateTimePickerField,
} from "@chatbotx.io/ui/components/form/date-picker-field"
import { FormFieldWrapper } from "@chatbotx.io/ui/components/form/field-wrapper"
import { InputField } from "@chatbotx.io/ui/components/form/input-field"
import { SelectField } from "@chatbotx.io/ui/components/form/select-field"
import { TextareaField } from "@chatbotx.io/ui/components/form/textarea-field"
import { Checkbox } from "@chatbotx.io/ui/components/ui/checkbox"
import { multiSelectItems } from "@chatbotx.io/utils/custom-field"
import { useTranslations } from "next-intl"
import { useId } from "react"

type BotFieldValueInputProps = {
  name?: string
  type: CustomFieldType
  saveFormat?: "formatted" | "iso"
  /** s201: the option list of a select / multiSelect custom field. */
  options?: string[] | null
}

/**
 * A multiSelect value edited as a checkbox list. The form value stays the
 * STORED text (canonical JSON array in option order), so the save action and
 * the server normalizer see exactly what will be stored.
 */
function MultiSelectJsonField(props: { name: string; options: string[] }) {
  const { name, options } = props
  const baseId = useId()
  return (
    <FormFieldWrapper name={name}>
      {(field) => {
        const picked = new Set(
          multiSelectItems(typeof field.value === "string" ? field.value : ""),
        )
        const toggle = (option: string, checked: boolean) => {
          if (checked) {
            picked.add(option)
          } else {
            picked.delete(option)
          }
          const ordered = options.filter((o) => picked.has(o))
          field.onChange(ordered.length === 0 ? "" : JSON.stringify(ordered))
        }
        return (
          <div className="flex flex-col gap-2" data-testid="multi-select-value">
            {options.map((option, index) => {
              const id = `${baseId}-${index}`
              return (
                <div className="flex min-w-0 items-center gap-2" key={option}>
                  <Checkbox
                    aria-labelledby={`${id}-label`}
                    checked={picked.has(option)}
                    onCheckedChange={(checked) =>
                      toggle(option, checked === true)
                    }
                  />
                  <span
                    className="truncate text-sm"
                    id={`${id}-label`}
                    title={option}
                  >
                    {option}
                  </span>
                </div>
              )
            })}
          </div>
        )
      }}
    </FormFieldWrapper>
  )
}

export const BotFieldValueInput = ({
  name = "value",
  saveFormat = "formatted",
  type,
  options,
}: BotFieldValueInputProps) => {
  const t = useTranslations()

  switch (type) {
    case "select":
      return (
        <SelectField
          allowClear
          clearLabel={t("actions.clear")}
          name={name}
          options={(options ?? []).map((o) => ({ label: o, value: o }))}
          placeholder={t("actions.pleaseSelect")}
        />
      )
    case "multiSelect":
      return <MultiSelectJsonField name={name} options={options ?? []} />
    case "number":
      return (
        <InputField
          name={name}
          placeholder={t("fields.number.placeholder")}
          type="number"
        />
      )
    case "boolean":
      return (
        <SelectField
          name={name}
          options={[
            { label: t("fields.boolean.true"), value: "true" },
            { label: t("fields.boolean.false"), value: "false" },
          ]}
          placeholder={t("fields.boolean.placeholder")}
        />
      )
    case "date": {
      return <DatePickerField name={name} saveFormat={saveFormat} />
    }
    case "datetime": {
      const dateTimeFormat = "yyyy-MM-dd HH:mm"
      return (
        <DateTimePickerField
          dateTimeFormat={dateTimeFormat}
          name={name}
          saveFormat={saveFormat}
        />
      )
    }
    case "longText":
      return (
        <TextareaField
          name={name}
          placeholder={t("fields.shortText.placeholder")}
        />
      )
    default:
      return (
        <InputField
          name={name}
          placeholder={t("fields.shortText.placeholder")}
        />
      )
  }
}
