"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import { Label } from "@chatbotx.io/ui/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import { Switch } from "@chatbotx.io/ui/components/ui/switch"
import { Textarea } from "@chatbotx.io/ui/components/ui/textarea"
import type {
  FormDefinition,
  FormField,
  FormSystemFieldKey,
} from "@chatbotx.io/utils/form"
import {
  FORM_OPTION_FIELD_TYPES,
  formSystemFieldKeys,
  isFormInputFieldType,
  MAX_FORM_OPTIONS,
} from "@chatbotx.io/utils/form"
import { PlusIcon, Trash2Icon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { useCustomFieldStore } from "@/features/custom-fields/provider/custom-field-store-context"
import {
  conditionSourcesBefore,
  renameFieldKey,
  updateField,
} from "../lib/editor-ops"
import { ConditionGroupEditor } from "./condition-group-editor"

const MAP_NONE = "__none__"
/** Custom-field types a text-shaped answer may be written to (PR3 adds select). */
const MAPPABLE_TYPES = new Set([
  "shortText",
  "longText",
  "email",
  "phoneNumber",
  "number",
  "date",
  "datetime",
  "boolean",
])

const mapToValue = (mapTo: FormField["mapTo"]): string => {
  if (mapTo === undefined) {
    return MAP_NONE
  }
  return mapTo.kind === "system"
    ? `system:${mapTo.key}`
    : `custom:${mapTo.customFieldId}`
}

/** Edits one field of the draft (s200): label, key, options, mapping, visibility. */
export function FieldInspector(props: {
  definition: FormDefinition
  field: FormField
  onChange: (definition: FormDefinition) => void
}) {
  const { definition, field, onChange } = props
  const t = useTranslations()
  const customFields = useCustomFieldStore((s) => s.customFields)
  const [keyDraft, setKeyDraft] = useState(field.key)
  const isInput = isFormInputFieldType(field.type)
  const sources = conditionSourcesBefore(definition, field.key)
  const patch = (p: Partial<Omit<FormField, "key">>) =>
    onChange(updateField(definition, field.key, p))
  const mapValue = mapToValue(field.mapTo)
  const mapItems = [
    { value: MAP_NONE, label: t("forms.editor.mapNone") },
    ...formSystemFieldKeys.options.map((k) => ({
      value: `system:${k}`,
      label: `${t("forms.editor.mapSystem")}: ${t(`forms.systemKeys.${k}`)}`,
    })),
    ...customFields
      .filter((cf) => MAPPABLE_TYPES.has(cf.type))
      .map((cf) => ({
        value: `custom:${cf.id}`,
        label: `${t("forms.editor.mapCustom")}: ${cf.name}`,
      })),
  ]

  return (
    <div
      className="flex flex-col gap-3"
      data-testid={`field-inspector-${field.key}`}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fi-label">{t("forms.editor.fieldLabel")}</Label>
        {field.type === "paragraph" ? (
          <Textarea
            id="fi-label"
            onChange={(e) => patch({ label: e.target.value })}
            value={field.label}
          />
        ) : (
          <Input
            id="fi-label"
            onChange={(e) => patch({ label: e.target.value })}
            value={field.label}
          />
        )}
      </div>
      {isInput ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fi-key">{t("forms.editor.fieldKey")}</Label>
            <Input
              id="fi-key"
              onBlur={() => {
                const next = renameFieldKey(definition, field.key, keyDraft)
                if (next === definition) {
                  setKeyDraft(field.key)
                } else {
                  onChange(next)
                }
              }}
              onChange={(e) => setKeyDraft(e.target.value)}
              value={keyDraft}
            />
          </div>
          {field.type !== "checkbox" && field.type !== "hidden" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fi-placeholder">
                {t("forms.editor.placeholder")}
              </Label>
              <Input
                id="fi-placeholder"
                onChange={(e) =>
                  patch({ placeholder: e.target.value || undefined })
                }
                value={field.placeholder ?? ""}
              />
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fi-help">{t("forms.editor.helpText")}</Label>
            <Input
              id="fi-help"
              onChange={(e) => patch({ helpText: e.target.value || undefined })}
              value={field.helpText ?? ""}
            />
          </div>
          {field.type === "hidden" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fi-default">
                {t("forms.editor.defaultValue")}
              </Label>
              <Input
                id="fi-default"
                onChange={(e) =>
                  patch({ defaultValue: e.target.value || undefined })
                }
                value={field.defaultValue ?? ""}
              />
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
            <Label htmlFor="fi-required">{t("forms.editor.required")}</Label>
            <Switch
              checked={field.required}
              id="fi-required"
              onCheckedChange={(required) => patch({ required })}
            />
          </div>
          {field.type === "number" ||
          field.type === "text" ||
          field.type === "textarea" ? (
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="fi-min">{t("forms.editor.min")}</Label>
                <Input
                  id="fi-min"
                  onChange={(e) =>
                    patch({
                      min:
                        e.target.value === ""
                          ? undefined
                          : Number(e.target.value),
                    })
                  }
                  type="number"
                  value={field.min ?? ""}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="fi-max">{t("forms.editor.max")}</Label>
                <Input
                  id="fi-max"
                  onChange={(e) =>
                    patch({
                      max:
                        e.target.value === ""
                          ? undefined
                          : Number(e.target.value),
                    })
                  }
                  type="number"
                  value={field.max ?? ""}
                />
              </div>
            </div>
          ) : null}
          {field.type === "text" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fi-pattern">{t("forms.editor.pattern")}</Label>
              <Input
                id="fi-pattern"
                onChange={(e) =>
                  patch({ pattern: e.target.value || undefined })
                }
                value={field.pattern ?? ""}
              />
            </div>
          ) : null}
          {FORM_OPTION_FIELD_TYPES.has(field.type) ? (
            <OptionsEditor
              field={field}
              onChange={(options) => patch({ options })}
            />
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label>{t("forms.editor.mapTo")}</Label>
            <Select
              items={mapItems}
              onValueChange={(raw) => {
                const v = raw === null || raw === undefined ? "" : String(raw)
                if (!v || v === MAP_NONE) {
                  patch({ mapTo: undefined })
                } else if (v.startsWith("system:")) {
                  patch({
                    mapTo: {
                      kind: "system",
                      key: v.slice(7) as FormSystemFieldKey,
                    },
                  })
                } else {
                  patch({
                    mapTo: { kind: "custom", customFieldId: v.slice(7) },
                  })
                }
              }}
              value={mapValue}
            >
              <SelectTrigger className="w-full" data-testid="fi-map-to">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {mapItems.map((i) => (
                  <SelectItem key={i.value} value={i.value}>
                    {i.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {FORM_OPTION_FIELD_TYPES.has(field.type) && field.mapTo ? (
              <span className="text-muted-foreground text-xs">
                {t("forms.editor.mapSelectHint")}
              </span>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label>{t("forms.editor.visibleWhen")}</Label>
              {field.visibleWhen ? (
                <Button
                  onClick={() => patch({ visibleWhen: undefined })}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {t("actions.clear")}
                </Button>
              ) : (
                <Button
                  disabled={sources.length === 0}
                  onClick={() =>
                    patch({ visibleWhen: { logic: "AND", rules: [] } })
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <PlusIcon className="size-3" />
                  {t("forms.editor.addCondition")}
                </Button>
              )}
            </div>
            {field.visibleWhen ? (
              <ConditionGroupEditor
                group={field.visibleWhen}
                onChange={(visibleWhen) => patch({ visibleWhen })}
                sources={sources}
                testId={`fi-visible-${field.key}`}
              />
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}

function OptionsEditor(props: {
  field: FormField
  onChange: (options: NonNullable<FormField["options"]>) => void
}) {
  const t = useTranslations()
  const options = props.field.options ?? []
  const set = (
    index: number,
    patch: Partial<{ value: string; label: string }>,
  ) =>
    props.onChange(
      options.map((o, i) => (i === index ? { ...o, ...patch } : o)),
    )
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{t("forms.editor.options")}</Label>
      {options.map((o, i) => (
        <div
          className="flex items-center gap-1"
          // biome-ignore lint/suspicious/noArrayIndexKey: options carry no id; the value is being edited
          key={i}
        >
          <Input
            aria-label={t("forms.editor.optionLabel")}
            className="h-8"
            onChange={(e) => set(i, { label: e.target.value })}
            placeholder={t("forms.editor.optionLabel")}
            value={o.label}
          />
          <Input
            aria-label={t("forms.editor.optionValue")}
            className="h-8"
            onChange={(e) => set(i, { value: e.target.value })}
            placeholder={t("forms.editor.optionValue")}
            value={o.value}
          />
          <Button
            aria-label={t("actions.delete")}
            disabled={options.length <= 1}
            onClick={() => props.onChange(options.filter((_, j) => j !== i))}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Trash2Icon className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        disabled={options.length >= MAX_FORM_OPTIONS}
        onClick={() =>
          props.onChange([
            ...options,
            {
              value: `option_${options.length + 1}`,
              label: `Option ${options.length + 1}`,
            },
          ])
        }
        size="sm"
        type="button"
        variant="outline"
      >
        <PlusIcon className="size-3" />
        {t("forms.editor.addOption")}
      </Button>
    </div>
  )
}
