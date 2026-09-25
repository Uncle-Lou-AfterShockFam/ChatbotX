"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import type {
  FormConditionGroup,
  FormConditionOp,
  FormConditionRule,
  FormField,
} from "@chatbotx.io/utils/form"
import {
  formConditionDepth,
  formConditionOps,
  isFormConditionGroup,
  MAX_FORM_CONDITION_DEPTH,
  MAX_FORM_RULES_PER_GROUP,
} from "@chatbotx.io/utils/form"
import { PlusIcon, Trash2Icon } from "lucide-react"
import { useTranslations } from "next-intl"

/**
 * Recursive AND / OR condition editor (s200). Unlike bakery_suite's builder
 * (which flattened nested groups away on save, s195 audit) this edits nested
 * groups in place, up to the shared depth cap.
 */
export function ConditionGroupEditor(props: {
  group: FormConditionGroup
  sources: FormField[]
  onChange: (group: FormConditionGroup) => void
  depth?: number
  testId?: string
}) {
  const { group, sources, onChange, depth = 1, testId = "condition" } = props
  const t = useTranslations()
  const NO_VALUE: FormConditionOp[] = ["is_empty", "is_not_empty"]
  const setRule = (
    index: number,
    next: FormConditionRule | FormConditionGroup,
  ) =>
    onChange({
      ...group,
      rules: group.rules.map((r, i) => (i === index ? next : r)),
    })
  const removeRule = (index: number) =>
    onChange({ ...group, rules: group.rules.filter((_, i) => i !== index) })
  const canAdd = group.rules.length < MAX_FORM_RULES_PER_GROUP
  const canNest =
    canAdd &&
    formConditionDepth(group) < MAX_FORM_CONDITION_DEPTH &&
    depth < MAX_FORM_CONDITION_DEPTH

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-dashed p-2"
      data-testid={testId}
    >
      <div className="flex items-center gap-2">
        <Select
          items={[
            { value: "AND", label: t("forms.editor.conditionAll") },
            { value: "OR", label: t("forms.editor.conditionAny") },
          ]}
          onValueChange={(v) =>
            (v === "AND" || v === "OR") && onChange({ ...group, logic: v })
          }
          value={group.logic}
        >
          <SelectTrigger className="h-8" data-testid={`${testId}-logic`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="AND">
              {t("forms.editor.conditionAll")}
            </SelectItem>
            <SelectItem value="OR">{t("forms.editor.conditionAny")}</SelectItem>
          </SelectContent>
        </Select>
        <div className="ms-auto flex gap-1">
          <Button
            disabled={!canAdd || sources.length === 0}
            onClick={() =>
              onChange({
                ...group,
                rules: [
                  ...group.rules,
                  { fieldKey: sources[0]?.key ?? "", op: "eq", value: "" },
                ],
              })
            }
            size="sm"
            type="button"
            variant="outline"
          >
            <PlusIcon className="size-3" />
            {t("forms.editor.addCondition")}
          </Button>
          <Button
            disabled={!canNest}
            onClick={() =>
              onChange({
                ...group,
                rules: [...group.rules, { logic: "AND", rules: [] }],
              })
            }
            size="sm"
            type="button"
            variant="ghost"
          >
            <PlusIcon className="size-3" />
            {t("forms.editor.addGroup")}
          </Button>
        </div>
      </div>
      {group.rules.map((rule, index) =>
        isFormConditionGroup(rule) ? (
          <div
            className="flex items-start gap-1" // biome-ignore lint/suspicious/noArrayIndexKey: condition nodes have no id
            key={`g-${index}`}
          >
            <div className="grow">
              <ConditionGroupEditor
                depth={depth + 1}
                group={rule}
                onChange={(next) => setRule(index, next)}
                sources={sources}
                testId={`${testId}-${index}`}
              />
            </div>
            <Button
              aria-label={t("actions.delete")}
              onClick={() => removeRule(index)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Trash2Icon className="size-4" />
            </Button>
          </div>
        ) : (
          <div
            className="flex flex-wrap items-center gap-1"
            data-testid={`${testId}-rule-${index}`}
            // biome-ignore lint/suspicious/noArrayIndexKey: condition nodes have no id
            key={`r-${index}`}
          >
            <Select
              items={sources.map((s) => ({
                value: s.key,
                label: s.label || s.key,
              }))}
              onValueChange={(v) =>
                v && setRule(index, { ...rule, fieldKey: String(v) })
              }
              value={rule.fieldKey}
            >
              <SelectTrigger className="h-8 max-w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sources.map((s) => (
                  <SelectItem key={s.key} value={s.key}>
                    {s.label || s.key}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              items={formConditionOps.options.map((op) => ({
                value: op,
                label: t(`forms.ops.${op}`),
              }))}
              onValueChange={(v) =>
                v &&
                setRule(index, { ...rule, op: String(v) as FormConditionOp })
              }
              value={rule.op}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {formConditionOps.options.map((op) => (
                  <SelectItem key={op} value={op}>
                    {t(`forms.ops.${op}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {NO_VALUE.includes(rule.op) ? null : (
              <Input
                className="h-8 w-32"
                onChange={(e) =>
                  setRule(index, { ...rule, value: e.target.value })
                }
                placeholder={t("forms.editor.valuePlaceholder")}
                value={rule.value === undefined ? "" : String(rule.value)}
              />
            )}
            <Button
              aria-label={t("actions.delete")}
              onClick={() => removeRule(index)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Trash2Icon className="size-4" />
            </Button>
          </div>
        ),
      )}
    </div>
  )
}
