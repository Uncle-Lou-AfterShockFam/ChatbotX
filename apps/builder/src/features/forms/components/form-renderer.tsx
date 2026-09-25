"use client"

import { Checkbox } from "@chatbotx.io/ui/components/ui/checkbox"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import { Label } from "@chatbotx.io/ui/components/ui/label"
import {
  RadioGroup,
  RadioGroupItem,
} from "@chatbotx.io/ui/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import { Separator } from "@chatbotx.io/ui/components/ui/separator"
import { Textarea } from "@chatbotx.io/ui/components/ui/textarea"
import { cn } from "@chatbotx.io/ui/lib/utils"
import type {
  FormDefinition,
  FormEvaluation,
  FormField,
  FormValidationIssue,
  FormValue,
  FormValues,
} from "@chatbotx.io/utils/form"
import { isFormInputFieldType } from "@chatbotx.io/utils/form"

/**
 * Renders the fields of ONE step against the current evaluation (s200).
 * Shared by the editor's Preview tab and the public page (PR2), so it has
 * no server imports and no translation dependency: every label comes from
 * the definition, the issue messages from `messages`.
 */
export type FormRendererProps = {
  definition: FormDefinition
  stepId: string
  values: FormValues
  evaluation: FormEvaluation
  issues: FormValidationIssue[]
  messages: Record<FormValidationIssue["code"], string>
  onChange: (key: string, value: FormValue) => void
  disabled?: boolean
  /** Prefix for input ids so two renderers on a page never collide. */
  idPrefix?: string
}

const INPUT_TYPES: Record<string, string> = {
  text: "text",
  email: "email",
  phone: "tel",
  url: "url",
  number: "number",
  date: "date",
  datetime: "datetime-local",
  time: "time",
}

export function FormRenderer(props: FormRendererProps) {
  const {
    definition,
    stepId,
    values,
    evaluation,
    issues,
    messages,
    onChange,
    disabled = false,
    idPrefix = "form",
  } = props
  const step = definition.steps.find((s) => s.id === stepId)
  if (!step) {
    return null
  }
  const issueFor = (key: string) => issues.find((i) => i.key === key)

  return (
    <div className="flex flex-col gap-4" data-testid={`form-step-${step.id}`}>
      {step.title ? (
        <h2 className="font-semibold text-lg">{step.title}</h2>
      ) : null}
      {step.description ? (
        <p className="text-muted-foreground text-sm">{step.description}</p>
      ) : null}
      {step.fields.map((field) => {
        if (!isFormInputFieldType(field.type)) {
          return <DisplayBlock field={field} key={field.key} />
        }
        if (!evaluation.visibleFields.has(field.key)) {
          return null
        }
        if (field.type === "hidden") {
          return null
        }
        const id = `${idPrefix}-${field.key}`
        const issue = issueFor(field.key)
        const required = evaluation.requiredFields.has(field.key)
        return (
          <div
            className="flex flex-col gap-1.5"
            data-testid={`form-field-${field.key}`}
            key={field.key}
          >
            {field.type === "checkbox" ? null : (
              <Label htmlFor={id}>
                {field.label || field.key}
                {required ? <span className="text-destructive"> *</span> : null}
              </Label>
            )}
            <FieldInput
              disabled={disabled}
              field={field}
              id={id}
              invalid={issue !== undefined}
              onChange={(v) => onChange(field.key, v)}
              required={required}
              value={values[field.key]}
            />
            {field.helpText ? (
              <span className="text-muted-foreground text-xs">
                {field.helpText}
              </span>
            ) : null}
            {issue ? (
              <span
                className="text-destructive text-xs"
                data-testid={`form-issue-${field.key}`}
                role="alert"
              >
                {messages[issue.code]}
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function DisplayBlock({ field }: { field: FormField }) {
  switch (field.type) {
    case "heading":
      return <h3 className="font-semibold text-base">{field.label}</h3>
    case "paragraph":
      return (
        <p className="whitespace-pre-wrap text-muted-foreground text-sm">
          {field.label}
        </p>
      )
    case "divider":
      return <Separator />
    default:
      return null
  }
}

function FieldInput(props: {
  field: FormField
  id: string
  value: FormValue
  onChange: (value: FormValue) => void
  disabled: boolean
  invalid: boolean
  required: boolean
}) {
  const { field, id, value, onChange, disabled, invalid, required } = props
  const options = field.options ?? []
  switch (field.type) {
    case "textarea":
      return (
        <Textarea
          aria-invalid={invalid}
          aria-required={required}
          disabled={disabled}
          id={id}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          value={typeof value === "string" ? value : ""}
        />
      )
    case "select":
      return (
        <Select
          disabled={disabled}
          items={options.map((o) => ({ value: o.value, label: o.label }))}
          onValueChange={(next) => onChange(next == null ? "" : String(next))}
          value={typeof value === "string" ? value : ""}
        >
          <SelectTrigger aria-invalid={invalid} className="w-full" id={id}>
            <SelectValue placeholder={field.placeholder} />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    case "radio":
      return (
        <RadioGroup
          aria-invalid={invalid}
          disabled={disabled}
          id={id}
          onValueChange={(next) => onChange(String(next ?? ""))}
          value={typeof value === "string" ? value : ""}
        >
          {options.map((o) => (
            <div className="flex items-center gap-2" key={o.value}>
              <RadioGroupItem id={`${id}-${o.value}`} value={o.value} />
              <Label htmlFor={`${id}-${o.value}`}>{o.label}</Label>
            </div>
          ))}
        </RadioGroup>
      )
    case "checkbox":
      return (
        <div className="flex items-center gap-2">
          <Checkbox
            aria-invalid={invalid}
            checked={value === true}
            disabled={disabled}
            id={id}
            onCheckedChange={(checked) => onChange(checked === true)}
          />
          <Label htmlFor={id}>
            {field.label || field.key}
            {required ? <span className="text-destructive"> *</span> : null}
          </Label>
        </div>
      )
    case "checkboxGroup": {
      const list = Array.isArray(value) ? value : []
      return (
        <div
          className={cn("flex flex-col gap-2", invalid && "text-destructive")}
        >
          {options.map((o) => (
            <div className="flex items-center gap-2" key={o.value}>
              <Checkbox
                checked={list.includes(o.value)}
                disabled={disabled}
                id={`${id}-${o.value}`}
                onCheckedChange={(checked) =>
                  onChange(
                    checked === true
                      ? [...list.filter((v) => v !== o.value), o.value]
                      : list.filter((v) => v !== o.value),
                  )
                }
              />
              <Label htmlFor={`${id}-${o.value}`}>{o.label}</Label>
            </div>
          ))}
        </div>
      )
    }
    default:
      return (
        <Input
          aria-invalid={invalid}
          aria-required={required}
          disabled={disabled}
          id={id}
          inputMode={field.type === "number" ? "decimal" : undefined}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          type={INPUT_TYPES[field.type] ?? "text"}
          value={
            typeof value === "string" || typeof value === "number"
              ? String(value)
              : ""
          }
        />
      )
  }
}
