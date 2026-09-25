"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import type {
  FormDefinition,
  FormValidationIssue,
  FormValue,
  FormValues,
} from "@chatbotx.io/utils/form"
import { evaluateForm, validateFormSubmission } from "@chatbotx.io/utils/form"
import { useTranslations } from "next-intl"
import { useMemo, useState } from "react"
import { FormRenderer } from "./form-renderer"

/**
 * Walks the steps like a submitter would (s200): hidden steps are skipped,
 * `skip_to_step` jumps, validation runs per step. Shared by the editor's
 * Preview tab (submit = show the values) and the public page (submit = POST).
 */
export function FormPreview(props: {
  definition: FormDefinition
  initialValues?: FormValues
  submitLabel: string
  onSubmit: (values: FormValues) => Promise<void> | void
  submitting?: boolean
  idPrefix?: string
}) {
  const {
    definition,
    submitLabel,
    onSubmit,
    submitting = false,
    idPrefix,
  } = props
  const t = useTranslations()
  const [values, setValues] = useState<FormValues>(() => ({
    ...defaults(definition),
    ...(props.initialValues ?? {}),
  }))
  const [stepIndex, setStepIndex] = useState(0)
  const [issues, setIssues] = useState<FormValidationIssue[]>([])
  const evaluation = useMemo(
    () => evaluateForm(definition, values),
    [definition, values],
  )
  const messages = useMemo(
    () =>
      Object.fromEntries(
        (
          [
            "required",
            "type",
            "option",
            "email",
            "url",
            "phone",
            "number",
            "min",
            "max",
            "pattern",
            "length",
            "date",
          ] as const
        ).map((code) => [code, t(`forms.issues.${code}`)]),
      ) as Record<FormValidationIssue["code"], string>,
    [t],
  )
  const visibleSteps = definition.steps.filter((s) =>
    evaluation.visibleSteps.has(s.id),
  )
  const step = definition.steps[stepIndex]
  if (!step) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("forms.editor.noStep")}
      </p>
    )
  }
  const stepKeys = new Set(step.fields.map((f) => f.key))
  const nextIndex = (): number | null => {
    const jump = evaluation.skipMap.get(step.id)
    let i = jump
      ? definition.steps.findIndex((s) => s.id === jump)
      : stepIndex + 1
    while (
      i < definition.steps.length &&
      !evaluation.visibleSteps.has(definition.steps[i].id)
    ) {
      i++
    }
    return i < definition.steps.length ? i : null
  }
  const validateStep = (): boolean => {
    const stepIssues = validateFormSubmission(
      definition,
      values,
      evaluation,
    ).filter((i) => stepKeys.has(i.key))
    setIssues(stepIssues)
    return stepIssues.length === 0
  }
  const isLast = nextIndex() === null
  const position = visibleSteps.findIndex((s) => s.id === step.id)

  return (
    <form
      className="flex flex-col gap-4"
      data-testid="form-preview"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!validateStep()) {
          return
        }
        const next = nextIndex()
        if (next === null) {
          const all = validateFormSubmission(definition, values, evaluation)
          if (all.length > 0) {
            setIssues(all)
            const firstBad = definition.steps.findIndex((s) =>
              s.fields.some((f) => all.some((i) => i.key === f.key)),
            )
            if (firstBad >= 0) {
              setStepIndex(firstBad)
            }
            return
          }
          await onSubmit(values)
        } else {
          setStepIndex(next)
        }
      }}
    >
      {visibleSteps.length > 1 ? (
        <span
          className="text-muted-foreground text-xs"
          data-testid="form-step-position"
        >
          {t("forms.editor.stepPosition", {
            current: position + 1,
            total: visibleSteps.length,
          })}
        </span>
      ) : null}
      <FormRenderer
        definition={definition}
        disabled={submitting}
        evaluation={evaluation}
        idPrefix={idPrefix}
        issues={issues}
        messages={messages}
        onChange={(key: string, value: FormValue) => {
          setValues((prev) => ({ ...prev, [key]: value }))
          setIssues((prev) => prev.filter((i) => i.key !== key))
        }}
        stepId={step.id}
        values={values}
      />
      <div className="flex items-center gap-2">
        {position > 0 ? (
          <Button
            onClick={() => {
              const prev = visibleSteps[position - 1]
              setStepIndex(definition.steps.findIndex((s) => s.id === prev.id))
              setIssues([])
            }}
            type="button"
            variant="ghost"
          >
            {t("forms.editor.previewBack")}
          </Button>
        ) : null}
        <Button className="ms-auto" disabled={submitting} type="submit">
          {isLast ? submitLabel : t("forms.editor.previewNext")}
        </Button>
      </div>
    </form>
  )
}

function defaults(definition: FormDefinition): FormValues {
  const out: FormValues = {}
  for (const step of definition.steps) {
    for (const field of step.fields) {
      if (field.defaultValue !== undefined) {
        out[field.key] = field.defaultValue
      }
    }
  }
  return out
}
