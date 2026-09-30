"use client"

import { SelectTagsInputField } from "@chatbotx.io/ui/components/form/select-tags-input-field"
import { Form } from "@chatbotx.io/ui/components/ui/form"
import { useTranslations } from "next-intl"
import { useEffect, useMemo } from "react"
import { useForm } from "react-hook-form"
import { useCustomFieldSelectOptions } from "@/features/custom-fields/provider/custom-field-hook"

/** The text-bearing contact system fields a step can require. */
const HOLD_SYSTEM_FIELDS = [
  "first_name",
  "last_name",
  "full_name",
  "email",
  "phone",
  "gender",
  "locale",
  "timezone",
] as const

/**
 * s227b outreach B-1 H3: the contact fields this step requires. A contact
 * missing one is HELD at the step (reason shown) until an operator resumes
 * it. Values are merge-field names (system ids, custom fields by name), the
 * same names the step's templates use.
 */
export function HoldOnMissingField({
  value,
  disabled,
  onChange,
}: {
  value: readonly string[] | null | undefined
  disabled?: boolean
  onChange: (fields: string[]) => void
}) {
  const t = useTranslations()
  const fieldOptions = useCustomFieldSelectOptions({
    includeReserved: true,
    reservedFieldIds: [...HOLD_SYSTEM_FIELDS],
    customFieldValueKey: "name",
  })
  const options = useMemo(
    () =>
      fieldOptions.map((option) => ({
        label: option.label,
        value: option.value,
      })),
    [fieldOptions],
  )
  const form = useForm<{ holdOnMissing: string[] }>({
    defaultValues: { holdOnMissing: [...(value ?? [])] },
  })
  // Re-sync when the saved step changes (a refresh after save, another
  // editor): defaultValues are read only once.
  const saved = (value ?? []).join("\u0000")
  useEffect(() => {
    form.reset({ holdOnMissing: saved ? saved.split("\u0000") : [] })
  }, [saved, form])

  return (
    <Form {...form}>
      <div className="mt-3" data-testid="sequence-step-hold">
        <SelectTagsInputField<{ holdOnMissing: string[] }>
          description={t("sequences.holdOnMissingDescription")}
          disabled={disabled}
          emptyMessage={t("fields.noResults.label")}
          label={t("sequences.holdOnMissingLabel")}
          maxTags={10}
          name="holdOnMissing"
          onSelect={(tags) => onChange(tags.map((tag) => tag.value))}
          options={options}
          placeholder={t("fields.search.placeholder")}
          searchPlaceholder={t("fields.search.placeholder")}
        />
      </div>
    </Form>
  )
}
