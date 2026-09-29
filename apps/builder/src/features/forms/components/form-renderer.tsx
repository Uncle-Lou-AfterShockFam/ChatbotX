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
import {
  FORM_UPLOAD_FIELD_TYPES,
  formScaleBounds,
  formUploadMaxBytes,
  formUploadMimeTypes,
  isFormInputFieldType,
} from "@chatbotx.io/utils/form"
import { PaperclipIcon, StarIcon } from "lucide-react"
import { useState } from "react"

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
  /**
   * s225a: how an `image` / `file` field sends its file (the public page's
   * upload route). Without `send` (the editor preview) the picker is off.
   */
  upload?: FormUploadHandler
}

export type FormUploadOutcome =
  | { ok: true; uploadId: string; name: string }
  | { ok: false; message: string }

export type FormUploadHandler = {
  send?: (field: FormField, file: File) => Promise<FormUploadOutcome>
  /** Called with +1 when an upload starts and -1 when it ends. */
  onBusy?: (delta: 1 | -1) => void
  labels: {
    uploading: string
    tooLarge: string
    failed: string
    previewOnly: string
  }
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
    upload,
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
              upload={upload}
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
  upload?: FormUploadHandler
}) {
  const { field, id, value, onChange, disabled, invalid, required } = props
  const options = field.options ?? []
  if (FORM_UPLOAD_FIELD_TYPES.has(field.type)) {
    return (
      <UploadInput
        disabled={disabled}
        field={field}
        id={id}
        invalid={invalid}
        onChange={onChange}
        required={required}
        upload={props.upload}
      />
    )
  }
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
    case "slider":
      return (
        <SliderInput
          disabled={disabled}
          field={field}
          id={id}
          invalid={invalid}
          onChange={onChange}
          value={value}
        />
      )
    case "rating":
      return (
        <RatingInput
          disabled={disabled}
          field={field}
          id={id}
          invalid={invalid}
          onChange={onChange}
          value={value}
        />
      )
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

const numericValue = (value: FormValue): number | null => {
  const n = typeof value === "string" ? Number(value) : value
  return typeof n === "number" && Number.isFinite(n) ? n : null
}

/**
 * s220c A2-4: a native range input (keyboard + screen readers for free). It
 * has no "empty" position: until the visitor clicks or keys it the THUMB is
 * hidden (a knob sitting mid-track looked answered; skeptic s220c), the
 * value reads "-", and a required slider stays unanswered.
 */
function SliderInput(props: {
  field: FormField
  id: string
  value: FormValue
  onChange: (value: FormValue) => void
  disabled: boolean
  invalid: boolean
}) {
  const { field, id, value, onChange, disabled, invalid } = props
  const { min, max, step } = formScaleBounds(field)
  const current = numericValue(value)
  return (
    <div className="flex items-center gap-3">
      <input
        aria-invalid={invalid}
        aria-valuetext={current === null ? "-" : String(current)}
        className={cn(
          "h-2 min-w-0 flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed",
          current === null &&
            "[&::-moz-range-thumb]:opacity-0 [&::-webkit-slider-thumb]:opacity-0",
        )}
        data-unanswered={current === null ? "true" : undefined}
        disabled={disabled}
        id={id}
        max={max}
        min={min}
        onChange={(e) => onChange(Number(e.target.value))}
        // a click or key on the hidden thumb's own spot (min, or Home at min)
        // fires no change event: commit what the control shows
        onKeyUp={(e) => onChange(Number(e.currentTarget.value))}
        onPointerUp={(e) => onChange(Number(e.currentTarget.value))}
        step={step}
        type="range"
        value={current ?? min}
      />
      <output
        className="w-12 shrink-0 text-right text-sm tabular-nums"
        data-testid={`${id}-value`}
        htmlFor={id}
      >
        {current === null ? "-" : current}
      </output>
    </div>
  )
}

/**
 * s220c A2-4: 1..max stars as NATIVE radios (arrow keys, form semantics and
 * screen readers for free); each star is the radio's visible label.
 */
function RatingInput(props: {
  field: FormField
  id: string
  value: FormValue
  onChange: (value: FormValue) => void
  disabled: boolean
  invalid: boolean
}) {
  const { field, id, value, onChange, disabled, invalid } = props
  const { max } = formScaleBounds(field)
  const current = numericValue(value)
  const stars = Array.from({ length: max }, (_, i) => i + 1)
  return (
    <fieldset
      aria-invalid={invalid}
      className="flex flex-wrap gap-1 border-0 p-0"
      disabled={disabled}
      id={id}
    >
      {stars.map((n) => (
        <label
          className="cursor-pointer rounded-md p-1 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
          data-testid={`${id}-star-${n}`}
          key={n}
        >
          <input
            aria-label={`${n}/${max}`}
            checked={current === n}
            className="sr-only"
            name={id}
            onChange={() => onChange(n)}
            type="radio"
            value={n}
          />
          <StarIcon
            aria-hidden="true"
            className={cn(
              "size-7",
              current !== null && n <= current
                ? "fill-amber-400 text-amber-400"
                : "text-muted-foreground",
            )}
          />
        </label>
      ))}
    </fieldset>
  )
}

/**
 * s225a A2-4 PR 5: one file per field, sent as soon as it is picked; the
 * field's value becomes the upload's opaque id (the submit claims it). The
 * size is checked here first only to spare a doomed request: the server
 * sniffs the bytes and enforces every limit again.
 */
function UploadInput(props: {
  field: FormField
  id: string
  onChange: (value: FormValue) => void
  disabled: boolean
  invalid: boolean
  required: boolean
  upload?: FormUploadHandler
}) {
  const { field, id, onChange, disabled, invalid, required, upload } = props
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "uploading"; name: string }
    | { kind: "done"; name: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" })
  const send = upload?.send
  const pick = async (file: File | undefined) => {
    if (!(file && send && upload)) {
      return
    }
    onChange("")
    if (file.size > formUploadMaxBytes(field)) {
      setState({ kind: "error", message: upload.labels.tooLarge })
      return
    }
    setState({ kind: "uploading", name: file.name })
    upload.onBusy?.(1)
    try {
      const outcome = await send(field, file)
      if (outcome.ok) {
        onChange(outcome.uploadId)
        setState({ kind: "done", name: outcome.name })
      } else {
        setState({ kind: "error", message: outcome.message })
      }
    } catch {
      setState({ kind: "error", message: upload.labels.failed })
    } finally {
      upload.onBusy?.(-1)
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <input
        accept={formUploadMimeTypes(field.type).join(",")}
        aria-invalid={invalid}
        className="block w-full min-w-0 text-sm file:me-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm disabled:cursor-not-allowed disabled:opacity-50"
        data-testid={`${id}-file`}
        disabled={disabled || !send || state.kind === "uploading"}
        id={id}
        onChange={(e) => {
          pick(e.target.files?.[0]).catch(() => undefined)
        }}
        required={required}
        type="file"
      />
      {send ? null : (
        <span className="text-muted-foreground text-xs">
          {upload?.labels.previewOnly}
        </span>
      )}
      {state.kind === "uploading" || state.kind === "done" ? (
        <span
          className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs"
          data-testid={`${id}-upload-${state.kind}`}
          role="status"
        >
          <PaperclipIcon aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">
            {state.kind === "uploading"
              ? `${upload?.labels.uploading} ${state.name}`
              : state.name}
          </span>
        </span>
      ) : null}
      {state.kind === "error" ? (
        <span
          className="text-destructive text-xs"
          data-testid={`${id}-upload-error`}
          role="alert"
        >
          {state.message}
        </span>
      ) : null}
    </div>
  )
}
