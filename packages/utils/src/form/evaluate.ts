import {
  FORM_LIST_FIELD_TYPES,
  FORM_OPTION_FIELD_TYPES,
  type FormConditionGroup,
  type FormConditionOp,
  type FormConditionRule,
  type FormDefinition,
  type FormField,
  formInputFields,
  isFormConditionGroup,
  isFormInputFieldType,
  MAX_FORM_VALUE,
} from "./definition"

/**
 * Pure evaluator shared by the editor preview, the public page and the submit
 * route. No I/O, no dates from the clock: `values` in, sets out.
 *
 * Precedence (sober-af-forms semantics, s195 audit):
 *   - a hidden STEP clamps every field in it, whatever a rule says;
 *   - a form-level `hide` beats `show`; `require` beats `optional`;
 *   - a hidden field is never required and never validated;
 *   - a condition that reads a hidden field reads `undefined` (so `is_empty`
 *     is true for it), never the stale answer.
 */

export type FormValue = string | number | boolean | string[] | null | undefined
export type FormValues = Record<string, FormValue>

export type FormEvaluation = {
  visibleSteps: Set<string>
  visibleFields: Set<string>
  requiredFields: Set<string>
  /** Forward jumps from a `skip_to_step` rule: from step id -> to step id. */
  skipMap: Map<string, string>
}

const isEmptyValue = (value: FormValue): boolean =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0)

const toNumber = (value: FormValue): number | null => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

const toText = (value: FormValue): string => {
  if (value === undefined || value === null) {
    return ""
  }
  if (Array.isArray(value)) {
    return value.join(",")
  }
  return String(value)
}

/** Compare one answer with one rule; unknown ops and NaN compare false. */
export function compareFormValue(
  op: FormConditionOp,
  actual: FormValue,
  expected: FormConditionRule["value"],
): boolean {
  switch (op) {
    case "is_empty":
      return isEmptyValue(actual)
    case "is_not_empty":
      return !isEmptyValue(actual)
    case "eq":
    case "neq": {
      let hit: boolean
      if (Array.isArray(actual)) {
        hit = actual.includes(toText(expected))
      } else if (typeof actual === "boolean" || typeof expected === "boolean") {
        hit = toText(actual).toLowerCase() === toText(expected).toLowerCase()
      } else {
        hit = toText(actual).toLowerCase() === toText(expected).toLowerCase()
      }
      return op === "eq" ? hit : !hit
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = toNumber(actual)
      const b = toNumber(expected)
      if (a === null || b === null) {
        return false
      }
      if (op === "gt") {
        return a > b
      }
      if (op === "gte") {
        return a >= b
      }
      if (op === "lt") {
        return a < b
      }
      return a <= b
    }
    case "contains":
    case "not_contains": {
      const needle = toText(expected).toLowerCase()
      const hit = Array.isArray(actual)
        ? actual.some((v) => v.toLowerCase() === needle)
        : toText(actual).toLowerCase().includes(needle)
      return op === "contains" ? hit : !hit
    }
    case "starts_with":
      return toText(actual)
        .toLowerCase()
        .startsWith(toText(expected).toLowerCase())
    case "ends_with":
      return toText(actual)
        .toLowerCase()
        .endsWith(toText(expected).toLowerCase())
    default:
      return false
  }
}

export function evaluateFormCondition(
  group: FormConditionGroup,
  read: (fieldKey: string) => FormValue,
): boolean {
  if (group.rules.length === 0) {
    return true
  }
  const results = group.rules.map((rule) =>
    isFormConditionGroup(rule)
      ? evaluateFormCondition(rule, read)
      : compareFormValue(rule.op, read(rule.fieldKey), rule.value),
  )
  return group.logic === "AND" ? results.every(Boolean) : results.some(Boolean)
}

/**
 * Resolve step / field visibility and required-ness for `values`.
 *
 * Visibility is resolved in ONE pass over steps in order, so a condition may
 * only read fields on the same or an earlier step reliably; a read of a field
 * that is hidden (or on a hidden step) yields `undefined`. Form-level rules
 * are applied after the field's own `visibleWhen`, hide beating show; a rule
 * cannot un-hide a field whose step is hidden.
 */
export function evaluateForm(
  def: FormDefinition,
  values: FormValues,
): FormEvaluation {
  const visibleSteps = new Set<string>()
  const visibleFields = new Set<string>()
  const requiredFields = new Set<string>()
  const skipMap = new Map<string, string>()
  const inputFields = new Map<string, FormField>()
  for (const field of formInputFields(def)) {
    inputFields.set(field.key, field)
  }

  // Reads see only fields resolved visible so far; everything else is undefined.
  const read = (key: string): FormValue =>
    visibleFields.has(key) ? values[key] : undefined

  // Pass 1: own conditions, step by step (a hidden step clamps its fields).
  for (const step of def.steps) {
    const stepVisible = step.visibleWhen
      ? evaluateFormCondition(step.visibleWhen, read)
      : true
    if (!stepVisible) {
      continue
    }
    visibleSteps.add(step.id)
    for (const field of step.fields) {
      if (!isFormInputFieldType(field.type)) {
        continue
      }
      const own = field.visibleWhen
        ? evaluateFormCondition(field.visibleWhen, read)
        : true
      if (own) {
        visibleFields.add(field.key)
      }
    }
  }

  // Pass 2: form-level rules against the pass-1 visibility.
  const shows = new Set<string>()
  const hides = new Set<string>()
  const requires = new Set<string>()
  const optionals = new Set<string>()
  const fieldStep = new Map<string, string>()
  for (const step of def.steps) {
    for (const field of step.fields) {
      fieldStep.set(field.key, step.id)
    }
  }
  for (const rule of def.rules) {
    if (!evaluateFormCondition(rule.when, read)) {
      continue
    }
    const action = rule.action
    switch (action.type) {
      case "show":
        shows.add(action.fieldKey)
        break
      case "hide":
        hides.add(action.fieldKey)
        break
      case "require":
        requires.add(action.fieldKey)
        break
      case "optional":
        optionals.add(action.fieldKey)
        break
      case "skip_to_step":
        if (!skipMap.has(action.fromStepId)) {
          skipMap.set(action.fromStepId, action.toStepId)
        }
        break
      default:
        break
    }
  }
  for (const key of shows) {
    const stepId = fieldStep.get(key)
    if (stepId && visibleSteps.has(stepId) && !hides.has(key)) {
      visibleFields.add(key)
    }
  }
  for (const key of hides) {
    visibleFields.delete(key)
  }

  // Required: the field's own flag, then optional, then require (wins).
  for (const key of visibleFields) {
    const field = inputFields.get(key)
    if (!field) {
      continue
    }
    let required = field.required
    if (optionals.has(key)) {
      required = false
    }
    if (requires.has(key)) {
      required = true
    }
    if (required) {
      requiredFields.add(key)
    }
  }

  return { visibleSteps, visibleFields, requiredFields, skipMap }
}

export type FormValidationIssue = {
  key: string
  code:
    | "required"
    | "type"
    | "option"
    | "email"
    | "url"
    | "phone"
    | "number"
    | "min"
    | "max"
    | "pattern"
    | "length"
    | "date"
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^\+?[0-9 ()./-]{6,30}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:"
  } catch {
    return false
  }
}

function validateOne(
  field: FormField,
  value: FormValue,
): FormValidationIssue["code"] | null {
  if (FORM_LIST_FIELD_TYPES.has(field.type)) {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      return "type"
    }
    const allowed = new Set((field.options ?? []).map((o) => o.value))
    return value.every((v) => allowed.has(v)) ? null : "option"
  }
  if (field.type === "checkbox") {
    return typeof value === "boolean" ? null : "type"
  }
  if (field.type === "number") {
    const n = toNumber(value)
    if (n === null) {
      return "number"
    }
    if (field.min !== undefined && n < field.min) {
      return "min"
    }
    if (field.max !== undefined && n > field.max) {
      return "max"
    }
    return null
  }
  if (typeof value !== "string") {
    return "type"
  }
  if (value.length > MAX_FORM_VALUE) {
    return "length"
  }
  if (FORM_OPTION_FIELD_TYPES.has(field.type)) {
    return (field.options ?? []).some((o) => o.value === value)
      ? null
      : "option"
  }
  if (field.min !== undefined && value.length < field.min) {
    return "min"
  }
  if (field.max !== undefined && value.length > field.max) {
    return "max"
  }
  switch (field.type) {
    case "email":
      return EMAIL_RE.test(value) ? null : "email"
    case "url":
      return isHttpUrl(value) ? null : "url"
    case "phone":
      return PHONE_RE.test(value) ? null : "phone"
    case "date":
      return DATE_RE.test(value) ? null : "date"
    case "time":
      return TIME_RE.test(value) ? null : "date"
    case "datetime":
      return DATETIME_RE.test(value) ? null : "date"
    default:
      break
  }
  if (field.pattern !== undefined) {
    try {
      if (!new RegExp(field.pattern).test(value)) {
        return "pattern"
      }
    } catch {
      return "pattern"
    }
  }
  return null
}

/**
 * Validate `values` against the definition for the given evaluation. Only
 * VISIBLE fields are checked; a required visible field with an empty answer
 * is `required`; a filled answer is type-checked per field type.
 */
export function validateFormSubmission(
  def: FormDefinition,
  values: FormValues,
  evaluation: FormEvaluation = evaluateForm(def, values),
): FormValidationIssue[] {
  const issues: FormValidationIssue[] = []
  for (const field of formInputFields(def)) {
    if (!evaluation.visibleFields.has(field.key)) {
      continue
    }
    const value = values[field.key]
    if (isEmptyValue(value)) {
      if (evaluation.requiredFields.has(field.key)) {
        issues.push({ key: field.key, code: "required" })
      }
      continue
    }
    const code = validateOne(field, value)
    if (code) {
      issues.push({ key: field.key, code })
    }
  }
  return issues
}

/**
 * Keep only answers for visible input fields (unknown keys and hidden fields
 * are DROPPED, never errors), so what is persisted equals what was validated.
 */
export function pruneFormValues(
  def: FormDefinition,
  values: FormValues,
  evaluation: FormEvaluation,
): FormValues {
  const out: FormValues = {}
  for (const field of formInputFields(def)) {
    if (!evaluation.visibleFields.has(field.key)) {
      continue
    }
    const value = values[field.key]
    if (!isEmptyValue(value)) {
      out[field.key] = value
    }
  }
  return out
}

export const isFormValueEmpty = isEmptyValue
