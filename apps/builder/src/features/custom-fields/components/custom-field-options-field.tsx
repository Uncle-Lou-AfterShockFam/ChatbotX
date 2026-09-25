"use client"

import { FormFieldWrapper } from "@chatbotx.io/ui/components/form/field-wrapper"
import { Textarea } from "@chatbotx.io/ui/components/ui/textarea"
import { useTranslations } from "next-intl"
import { useEffect, useState } from "react"

/** Textarea text -> option list: one option per line, blank lines dropped. */
export const customFieldOptionsFromText = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

/**
 * The option list of a select / multi-select custom field (s201), edited as
 * one option per line. The raw text is local state so Enter and blank lines
 * type normally; the form value is the parsed list.
 */
export function CustomFieldOptionsField(props: {
  name?: string
  /** Shown under the field when editing an existing field's options. */
  hint?: string
}) {
  const { name = "options", hint } = props
  const t = useTranslations()
  return (
    <FormFieldWrapper
      description={hint ?? t("fields.customFieldOptions.description")}
      label={t("fields.customFieldOptions.label")}
      name={name}
      required
    >
      {(field) => (
        <OptionsTextarea
          onBlur={field.onBlur}
          onChange={(options) => field.onChange(options)}
          value={Array.isArray(field.value) ? (field.value as string[]) : []}
        />
      )}
    </FormFieldWrapper>
  )
}

function OptionsTextarea(props: {
  value: string[]
  onChange: (options: string[]) => void
  onBlur: () => void
}) {
  const t = useTranslations()
  const [text, setText] = useState(() => props.value.join("\n"))
  const joined = props.value.join("\n")
  // Follow an EXTERNAL value change (the edit dialog's setValue after mount);
  // typing keeps parsed text and value equal, so it never clobbers input.
  useEffect(() => {
    setText((current) =>
      customFieldOptionsFromText(current).join("\n") === joined
        ? current
        : joined,
    )
  }, [joined])
  return (
    <Textarea
      data-testid="custom-field-options"
      onBlur={props.onBlur}
      onChange={(e) => {
        setText(e.target.value)
        props.onChange(customFieldOptionsFromText(e.target.value))
      }}
      placeholder={t("fields.customFieldOptions.placeholder")}
      rows={5}
      value={text}
    />
  )
}
