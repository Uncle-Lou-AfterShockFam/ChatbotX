"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import type { FormDefinition, FormRule } from "@chatbotx.io/utils/form"
import { MAX_FORM_RULES } from "@chatbotx.io/utils/form"
import { PlusIcon, Trash2Icon } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  addRule,
  conditionSources,
  removeRule,
  uniqueRuleId,
  updateRule,
} from "../lib/editor-ops"
import { ConditionGroupEditor } from "./condition-group-editor"

const ACTIONS = ["show", "hide", "require", "optional", "skip_to_step"] as const

/** Form-level rules: when <conditions> then show / hide / require / optional / skip. */
export function FormRulesEditor(props: {
  definition: FormDefinition
  onChange: (definition: FormDefinition) => void
}) {
  const { definition, onChange } = props
  const t = useTranslations()
  const sources = conditionSources(definition)
  const stepItems = definition.steps.map((s, i) => ({
    value: s.id,
    label: s.title || `${t("forms.editor.step")} ${i + 1}`,
  }))
  const fieldItems = sources.map((f) => ({
    value: f.key,
    label: f.label || f.key,
  }))

  const setAction = (rule: FormRule, type: (typeof ACTIONS)[number]) => {
    const action: FormRule["action"] =
      type === "skip_to_step"
        ? {
            type,
            fromStepId: definition.steps[0]?.id ?? "",
            toStepId: definition.steps[1]?.id ?? definition.steps[0]?.id ?? "",
          }
        : { type, fieldKey: sources[0]?.key ?? "" }
    onChange(updateRule(definition, rule.id, { action }))
  }

  return (
    <div className="flex flex-col gap-3" data-testid="form-rules">
      {definition.rules.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t("forms.editor.noRules")}
        </p>
      ) : null}
      {definition.rules.map((rule) => (
        <div
          className="flex flex-col gap-2 rounded-md border p-3"
          data-testid={`form-rule-${rule.id}`}
          key={rule.id}
        >
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">
              {t("forms.editor.when")}
            </span>
            <Button
              aria-label={t("actions.delete")}
              className="ms-auto"
              onClick={() => onChange(removeRule(definition, rule.id))}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Trash2Icon className="size-4" />
            </Button>
          </div>
          <ConditionGroupEditor
            group={rule.when}
            onChange={(when) =>
              onChange(updateRule(definition, rule.id, { when }))
            }
            sources={sources}
            testId={`form-rule-${rule.id}-when`}
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-sm">
              {t("forms.editor.then")}
            </span>
            <Select
              items={ACTIONS.map((a) => ({
                value: a,
                label: t(`forms.ruleActions.${a}`),
              }))}
              onValueChange={(v) =>
                v && setAction(rule, String(v) as (typeof ACTIONS)[number])
              }
              value={rule.action.type}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACTIONS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {t(`forms.ruleActions.${a}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {rule.action.type === "skip_to_step" ? (
              <>
                <span className="text-muted-foreground text-xs">
                  {t("forms.editor.ruleFrom")}
                </span>
                <StepSelect
                  items={stepItems}
                  onChange={(fromStepId) =>
                    rule.action.type === "skip_to_step" &&
                    onChange(
                      updateRule(definition, rule.id, {
                        action: { ...rule.action, fromStepId },
                      }),
                    )
                  }
                  value={rule.action.fromStepId}
                />
                <span className="text-muted-foreground text-xs">
                  {t("forms.editor.ruleTo")}
                </span>
                <StepSelect
                  items={stepItems}
                  onChange={(toStepId) =>
                    rule.action.type === "skip_to_step" &&
                    onChange(
                      updateRule(definition, rule.id, {
                        action: { ...rule.action, toStepId },
                      }),
                    )
                  }
                  value={rule.action.toStepId}
                />
              </>
            ) : (
              <StepSelect
                items={fieldItems}
                onChange={(fieldKey) =>
                  rule.action.type !== "skip_to_step" &&
                  onChange(
                    updateRule(definition, rule.id, {
                      action: { ...rule.action, fieldKey },
                    }),
                  )
                }
                value={rule.action.fieldKey}
              />
            )}
          </div>
        </div>
      ))}
      <Button
        disabled={
          definition.rules.length >= MAX_FORM_RULES || sources.length === 0
        }
        onClick={() =>
          onChange(
            addRule(definition, {
              id: uniqueRuleId(definition),
              when: { logic: "AND", rules: [] },
              action: { type: "show", fieldKey: sources[0]?.key ?? "" },
            }),
          )
        }
        size="sm"
        type="button"
        variant="outline"
      >
        <PlusIcon className="size-4" />
        {t("forms.actions.addRule")}
      </Button>
    </div>
  )
}

function StepSelect(props: {
  items: { value: string; label: string }[]
  value: string
  onChange: (value: string) => void
}) {
  return (
    <Select
      items={props.items}
      onValueChange={(v) => v && props.onChange(String(v))}
      value={props.value}
    >
      <SelectTrigger className="h-8 max-w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {props.items.map((i) => (
          <SelectItem key={i.value} value={i.value}>
            {i.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
