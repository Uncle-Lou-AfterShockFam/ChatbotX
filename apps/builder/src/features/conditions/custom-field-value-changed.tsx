import {
  type CustomFieldType,
  operatorTypes,
} from "@chatbotx.io/database/partials"
import { DateTimePicker } from "@chatbotx.io/ui/components/ui/date-picker"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import { MultiSelect } from "@chatbotx.io/ui/components/ui/sersavan/multi-select"
import { Textarea } from "@chatbotx.io/ui/components/ui/textarea"
import {
  customFieldTypes,
  isOptionFieldType,
  optionOperatorTakesList,
} from "@chatbotx.io/utils/custom-field"
import { useTranslations } from "next-intl"
import { useMemo } from "react"
import { Controller, useFormContext } from "react-hook-form"
import { getConditionOptions } from "@/features/contact-filter/components/contact-filter-config"
import { relabelOptionOperators } from "@/features/contact-filter/components/custom-field-filter-config"
import { getBrowserTimezone } from "@/features/contact-filter/lib/timezone"
import {
  convertCustomFieldTypeToConditionType,
  mappingConditions,
} from "@/features/contact-filter/schema"
import { CustomFieldSelect } from "@/features/custom-fields/custom-field-select"
import { useCustomFieldStore } from "@/features/custom-fields/provider/custom-field-store-context"

export const CustomFieldValueChanged = ({
  parentName,
}: {
  parentName: string
}) => {
  const t = useTranslations()
  const conditionOptions = getConditionOptions(t)
  const form = useFormContext()
  const { customFields } = useCustomFieldStore((state) => state)

  const customFieldId = form.watch(`${parentName}.sourceId`)

  const customField = useMemo(
    () => customFields.find((field) => field.id === customFieldId),
    [customFieldId, customFields],
  )
  const customFieldType = customField?.type as CustomFieldType
  const optionType =
    customFieldType && isOptionFieldType(customFieldType)
      ? customFieldType
      : undefined
  // s203: a select / multiSelect picks from its options, stored as
  // `{ options: [...] }` for a list operator and `{ text }` for a select
  // `eq` / `ne` (see `matchesOptionCondition`).
  const optionItems = useMemo(
    () => (customField?.options ?? []).map((o) => ({ label: o, value: o })),
    [customField],
  )

  const conditionType = useMemo(
    () => convertCustomFieldTypeToConditionType(customFieldType),
    [customFieldType],
  )

  const operatorOptions = useMemo(() => {
    if (!customFieldId) {
      return []
    }

    const enableOperators = mappingConditions[conditionType]
    if (optionType) {
      // An option field offers exactly its own operators, in its own words.
      const byValue = new Map(conditionOptions.map((o) => [o.value, o]))
      return relabelOptionOperators(
        enableOperators.map((operator) => ({
          value: operator,
          label: byValue.get(operator)?.label ?? operator,
        })),
        optionType,
        t,
      )
    }
    return conditionOptions.map((option) => ({
      ...option,
      disabled: !enableOperators.includes(option.value),
    }))
  }, [conditionOptions, customFieldId, conditionType, optionType, t])

  const currentOperator = form.watch(`${parentName}.operator`)
  const optionValueMode = (() => {
    if (
      !optionType ||
      currentOperator === operatorTypes.enum.isEmpty ||
      currentOperator === operatorTypes.enum.isNotEmpty
    ) {
      return
    }
    return optionOperatorTakesList(optionType, currentOperator) ? "list" : "one"
  })()

  return (
    <div className="flex flex-col gap-4">
      <CustomFieldSelect
        label=""
        name={`${parentName}.sourceId`}
        onValueChange={(nextFieldId) => {
          form.resetField(`${parentName}.value`)
          // s203: an operator carried over from another field type (e.g. a
          // text `notContains` onto a select) would match every change: start
          // the new field on its own first operator.
          const nextType = customFields.find(
            (field) => field.id === nextFieldId,
          )?.type
          const [firstOperator] =
            mappingConditions[convertCustomFieldTypeToConditionType(nextType)]
          form.setValue(`${parentName}.operator`, firstOperator ?? "")
        }}
      />
      {customFieldId && (
        <>
          <Select
            items={operatorOptions}
            onValueChange={(value) => {
              // An option field's value shape follows the operator (one
              // option or a list): switching shape clears the value.
              if (
                optionType &&
                optionOperatorTakesList(optionType, String(value ?? "")) !==
                  optionOperatorTakesList(optionType, currentOperator)
              ) {
                form.setValue(`${parentName}.value`, "")
              }
              form.setValue(`${parentName}.operator`, value, {
                shouldValidate: true,
              })
            }}
            value={currentOperator}
          >
            <SelectTrigger>
              <SelectValue placeholder={t("actions.pleaseSelect")} />
            </SelectTrigger>
            <SelectContent>
              {operatorOptions.map((option) => (
                <SelectItem
                  disabled={option.disabled}
                  key={option.value}
                  value={option.value}
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {optionValueMode === "one" && (
            <Controller
              control={form.control}
              name={`${parentName}.value`}
              render={({ field }) => (
                <Select
                  items={optionItems}
                  onValueChange={(value) => field.onChange({ text: value })}
                  value={field.value?.text || ""}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("actions.pleaseSelect")} />
                  </SelectTrigger>
                  <SelectContent>
                    {optionItems.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          )}

          {optionValueMode === "list" && (
            <Controller
              control={form.control}
              name={`${parentName}.value`}
              render={({ field }) => (
                <MultiSelect
                  defaultValue={
                    Array.isArray(field.value?.options)
                      ? field.value.options
                      : []
                  }
                  key={`${customFieldId}:${currentOperator}`}
                  modalPopover={true}
                  onValueChange={(options) =>
                    field.onChange(options.length > 0 ? { options } : "")
                  }
                  options={optionItems}
                  placeholder={t("actions.pleaseSelect")}
                />
              )}
            />
          )}

          {customFieldType === customFieldTypes.enum.longText && (
            <Controller
              control={form.control}
              name={`${parentName}.value`}
              render={({ field }) => (
                <Textarea
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                    field.onChange({ text: e.target.value })
                  }
                  value={field.value?.text || ""}
                />
              )}
            />
          )}

          {customFieldType === customFieldTypes.enum.shortText && (
            <Controller
              control={form.control}
              name={`${parentName}.value`}
              render={({ field }) => (
                <Input
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    field.onChange({ text: e.target.value })
                  }
                  value={field.value?.text || ""}
                />
              )}
            />
          )}

          {customFieldType === customFieldTypes.enum.number && (
            <Controller
              control={form.control}
              name={`${parentName}.value`}
              render={({ field }) => (
                <Input
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    field.onChange({ text: e.target.value })
                  }
                  type="number"
                  value={field.value?.text || ""}
                />
              )}
            />
          )}

          {customFieldType === customFieldTypes.enum.date && (
            <Controller
              control={form.control}
              name={`${parentName}.value`}
              render={({ field }) => (
                <DateTimePicker
                  displayFormat={{ hour24: "yyyy-MM-dd" }}
                  granularity="day"
                  onChange={(date: Date | undefined) =>
                    field.onChange({
                      text: date?.toISOString(),
                      timezone: getBrowserTimezone(),
                    })
                  }
                  value={
                    field.value?.text ? new Date(field.value.text) : undefined
                  }
                />
              )}
            />
          )}

          {customFieldType === customFieldTypes.enum.datetime && (
            <Controller
              control={form.control}
              name={`${parentName}.value`}
              render={({ field }) => (
                <DateTimePicker
                  onChange={(date: Date | undefined) =>
                    field.onChange({
                      text: date?.toISOString(),
                      timezone: getBrowserTimezone(),
                    })
                  }
                  value={
                    field.value?.text ? new Date(field.value.text) : undefined
                  }
                />
              )}
            />
          )}

          {customFieldType === customFieldTypes.enum.boolean &&
            form.getValues(`${parentName}.operator`) ===
              operatorTypes.enum.eq && (
              <Controller
                control={form.control}
                name={`${parentName}.value`}
                render={({ field }) => (
                  <Select
                    items={[
                      { label: t("fields.boolean.true"), value: "true" },
                      { label: t("fields.boolean.false"), value: "false" },
                    ]}
                    onValueChange={(value) =>
                      field.onChange({
                        text: value === "true" ? "true" : "false",
                      })
                    }
                    value={field.value?.text || ""}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t("actions.pleaseSelect")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="true">
                        {t("fields.boolean.true")}
                      </SelectItem>
                      <SelectItem value="false">
                        {t("fields.boolean.false")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            )}
        </>
      )}
    </div>
  )
}
