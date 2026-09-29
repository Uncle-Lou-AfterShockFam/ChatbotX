import {
  collectRuleKeys,
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
import { isHttpUrl } from "./url"

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

export const isEmptyFormValue = (value: FormValue): boolean =>
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

/** Text of ONE scalar; anything that is not string / number / boolean is "". */
const scalarText = (value: unknown): string => {
  switch (typeof value) {
    case "string":
      return value
    case "number":
      return Number.isFinite(value) ? String(value) : ""
    case "boolean":
      return value ? "true" : "false"
    default:
      return ""
  }
}

/** Text of an answer; a list joins its string elements, never throws. */
const toText = (value: unknown): string => {
  if (Array.isArray(value)) {
    return value.map(scalarText).join(",")
  }
  return scalarText(value)
}

const listText = (value: unknown[]): string[] =>
  value.filter((v): v is string => typeof v === "string")

/** Own-property read: a field keyed `constructor` must not read the prototype. */
export const readFormValue = (values: FormValues, key: string): FormValue =>
  Object.hasOwn(values, key) ? values[key] : undefined

/** Compare one answer with one rule; unknown ops and NaN compare false. */
export function compareFormValue(
  op: FormConditionOp,
  actual: FormValue,
  expected: FormConditionRule["value"],
): boolean {
  switch (op) {
    case "is_empty":
      return isEmptyFormValue(actual)
    case "is_not_empty":
      return !isEmptyFormValue(actual)
    case "eq":
    case "neq": {
      const hit = Array.isArray(actual)
        ? listText(actual).includes(toText(expected))
        : toText(actual).toLowerCase() === toText(expected).toLowerCase()
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
        ? listText(actual).some((v) => v.toLowerCase() === needle)
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
    visibleFields.has(key) ? readFormValue(values, key) : undefined

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
  const stepIndex = new Map<string, number>()
  for (const [index, step] of def.steps.entries()) {
    stepIndex.set(step.id, index)
    for (const field of step.fields) {
      fieldStep.set(field.key, step.id)
    }
  }
  // A jump may only be decided by answers the contact gave BEFORE leaving
  // its source step. A rule that reads a field on a step it would jump over
  // would, once answered, erase its own answer (skeptic, s219 A2-2): such a
  // rule never jumps.
  const decidedBeforeJump = (when: FormConditionGroup, fromStepId: string) => {
    const from = stepIndex.get(fromStepId) ?? -1
    return collectRuleKeys(when, []).every(
      (key) =>
        (stepIndex.get(fieldStep.get(key) ?? "") ?? Number.POSITIVE_INFINITY) <=
        from,
    )
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
        if (
          !skipMap.has(action.fromStepId) &&
          decidedBeforeJump(rule.when, action.fromStepId)
        ) {
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

  // A step jumped over by a `skip_to_step` is never shown, so it is hidden
  // like a step whose own condition failed: its fields are neither required
  // nor kept (s219 A2-2: a required field the contact never saw can never
  // block the submit, on the web page or in chat).
  const reached = new Set<string>()
  let i = 0
  while (i < def.steps.length) {
    const step = def.steps[i]
    if (!visibleSteps.has(step.id)) {
      i++
      continue
    }
    reached.add(step.id)
    const jump = skipMap.get(step.id)
    const target = jump ? def.steps.findIndex((s) => s.id === jump) : -1
    // Publish refuses a backward or missing target; a lenient read must
    // still never loop, so only a forward jump is followed.
    i = target > i ? target : i + 1
  }
  for (const stepId of visibleSteps) {
    if (!reached.has(stepId)) {
      visibleSteps.delete(stepId)
    }
  }
  for (const key of visibleFields) {
    const stepId = fieldStep.get(key)
    if (stepId && !reached.has(stepId)) {
      visibleFields.delete(key)
    }
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
    | "location"
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^\+?[0-9 ()./-]{6,30}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/
/** A shared location as "lat,lng" in decimal degrees (a chat answer). */
const LOCATION_RE = /^(-?\d{1,2}(?:\.\d{1,10})?),\s?(-?\d{1,3}(?:\.\d{1,10})?)$/

const isLocation = (value: string): boolean => {
  const match = LOCATION_RE.exec(value)
  if (!match) {
    return false
  }
  const lat = Number(match[1])
  const lng = Number(match[2])
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180
}

/**
 * Type-check ONE non-empty answer against its field (required-ness is the
 * caller's: see `validateFormSubmission`). A chat run checks each reply with
 * this before storing it, so a chat answer and a web answer pass the same rule.
 */
export function validateFormField(
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
    // A chat run stores the received photo / file and answers with its URL
    // (http allowed for a local storage origin). Anything that later FETCHES
    // such a value server-side goes through the pinned outbound fetch.
    case "image":
    case "file":
      return isHttpUrl(value) ? null : "url"
    case "location":
      return isLocation(value) ? null : "location"
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
 *
 * `suppressed` = visible fields the contact was never asked (progressive
 * profiling in a chat run): an empty answer there is not `required`, the
 * Mautic "hidden required field" rule (SubmissionModel.php:205-209). The web
 * page asks every visible field, so it passes none.
 */
export function validateFormSubmission(
  def: FormDefinition,
  values: FormValues,
  evaluation: FormEvaluation = evaluateForm(def, values),
  options: { suppressed?: ReadonlySet<string> } = {},
): FormValidationIssue[] {
  const issues: FormValidationIssue[] = []
  for (const field of formInputFields(def)) {
    if (!evaluation.visibleFields.has(field.key)) {
      continue
    }
    const value = readFormValue(values, field.key)
    if (isEmptyFormValue(value)) {
      if (
        evaluation.requiredFields.has(field.key) &&
        !options.suppressed?.has(field.key)
      ) {
        issues.push({ key: field.key, code: "required" })
      }
      continue
    }
    const code = validateFormField(field, value)
    if (code) {
      issues.push({ key: field.key, code })
    }
  }
  return issues
}

/**
 * A `hidden` field's value is the FORM's, never the visitor's (s220c A2-4):
 * every hidden field is set to its `defaultValue` (or dropped when it has
 * none), whatever the caller sent. The one exception is a key the form lists
 * in `prefillKeys`: a link may set it, and a sent value is kept (it is still
 * validated like any answer). The web page seeded the default only in the
 * browser, so a tampered POST could store any value; a chat run never asked
 * hidden fields, so their default was never stored at all.
 */
export function applyHiddenDefaults(
  def: FormDefinition,
  values: FormValues,
  prefillable: ReadonlySet<string> = new Set(),
): FormValues {
  const out: FormValues = { ...values }
  for (const field of formInputFields(def)) {
    if (field.type !== "hidden") {
      continue
    }
    if (
      prefillable.has(field.key) &&
      !isEmptyFormValue(readFormValue(values, field.key))
    ) {
      continue
    }
    if (field.defaultValue === undefined || field.defaultValue === "") {
      delete out[field.key]
    } else {
      out[field.key] = field.defaultValue
    }
  }
  return out
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
    const value = readFormValue(values, field.key)
    if (!isEmptyFormValue(value)) {
      out[field.key] = value
    }
  }
  return out
}

/**
 * Sum of the `points` of every chosen option on a VISIBLE field (a scored
 * questionnaire); `null` when no option in the form carries points, so an
 * unscored form never reports a score of 0.
 */
export function formScore(
  def: FormDefinition,
  values: FormValues,
  evaluation: FormEvaluation = evaluateForm(def, values),
): number | null {
  let scored = false
  let total = 0
  for (const field of formInputFields(def)) {
    const options = field.options ?? []
    if (options.some((o) => o.points !== undefined)) {
      scored = true
    }
    if (!evaluation.visibleFields.has(field.key)) {
      continue
    }
    const value = readFormValue(values, field.key)
    const chosen = Array.isArray(value)
      ? new Set(value)
      : new Set(typeof value === "string" ? [value] : [])
    for (const option of options) {
      if (chosen.has(option.value)) {
        total += option.points ?? 0
      }
    }
  }
  return scored ? total : null
}
