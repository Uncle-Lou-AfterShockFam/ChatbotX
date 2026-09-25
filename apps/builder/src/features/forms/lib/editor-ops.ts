import type {
  FormConditionGroup,
  FormDefinition,
  FormField,
  FormRule,
  FormStep,
  WebFormFieldType,
} from "@chatbotx.io/utils/form"
import {
  FORM_FIELD_KEY_REGEX,
  FORM_OPTION_FIELD_TYPES,
  isFormInputFieldType,
  MAX_FORM_FIELDS_PER_STEP,
  MAX_FORM_RULES,
  MAX_FORM_STEPS,
} from "@chatbotx.io/utils/form"

/**
 * Pure editor operations over a draft definition (s200). Every op returns a
 * NEW definition and never mutates its input, so the editor store can diff
 * and the tests can assert. Caps are enforced here too, so the UI cannot
 * build a draft the service would refuse.
 */

const STARTS_WITH_LETTER = /^[a-z]/

const takenKeys = (def: FormDefinition): Set<string> => {
  const keys = new Set<string>()
  for (const step of def.steps) {
    for (const field of step.fields) {
      keys.add(field.key)
    }
  }
  return keys
}

/** `First name` -> `first_name`; `_2`, `_3` on collision; never empty. */
export function uniqueFieldKey(def: FormDefinition, label: string): string {
  let base = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36)
  if (!STARTS_WITH_LETTER.test(base)) {
    base = `f_${base}`.replace(/_+$/g, "")
  }
  if (base === "" || base === "f") {
    base = "field"
  }
  const taken = takenKeys(def)
  if (!taken.has(base) && FORM_FIELD_KEY_REGEX.test(base)) {
    return base
  }
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base.slice(0, 36)}_${n}`
    if (!taken.has(candidate)) {
      return candidate
    }
  }
  return `${base.slice(0, 20)}_${Date.now().toString(36)}`
}

export function uniqueStepId(def: FormDefinition): string {
  const taken = new Set(def.steps.map((s) => s.id))
  for (let n = def.steps.length + 1; n < 1000; n++) {
    const candidate = `step-${n}`
    if (!taken.has(candidate)) {
      return candidate
    }
  }
  return `step-${Date.now().toString(36)}`
}

export function newField(
  def: FormDefinition,
  type: WebFormFieldType,
  label: string,
): FormField {
  const field: FormField = {
    key: uniqueFieldKey(def, label),
    type,
    label,
    required: false,
  }
  if (FORM_OPTION_FIELD_TYPES.has(type)) {
    field.options = [
      { value: "option_1", label: "Option 1" },
      { value: "option_2", label: "Option 2" },
    ]
  }
  return field
}

export function addStep(def: FormDefinition, title = ""): FormDefinition {
  if (def.steps.length >= MAX_FORM_STEPS) {
    return def
  }
  const step: FormStep = { id: uniqueStepId(def), title, fields: [] }
  return { ...def, steps: [...def.steps, step] }
}

export function updateStep(
  def: FormDefinition,
  stepId: string,
  patch: Partial<Omit<FormStep, "id" | "fields">>,
): FormDefinition {
  return {
    ...def,
    steps: def.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
  }
}

/** Removing a step drops its fields and every rule / condition that read them. */
export function removeStep(
  def: FormDefinition,
  stepId: string,
): FormDefinition {
  const step = def.steps.find((s) => s.id === stepId)
  if (!step) {
    return def
  }
  let next: FormDefinition = {
    ...def,
    steps: def.steps.filter((s) => s.id !== stepId),
  }
  for (const field of step.fields) {
    next = dropReferences(next, field.key)
  }
  next = {
    ...next,
    rules: next.rules.filter(
      (r) =>
        r.action.type !== "skip_to_step" ||
        (r.action.fromStepId !== stepId && r.action.toStepId !== stepId),
    ),
  }
  return next
}

/**
 * After a reorder, prune condition rules that now read a LATER field (the
 * strict schema refuses them and the evaluator would read undefined).
 */
function dropForwardReferences(def: FormDefinition): FormDefinition {
  const order = new Map<string, number>()
  const stepOf = new Map<string, number>()
  let n = 0
  def.steps.forEach((step, si) => {
    for (const field of step.fields) {
      order.set(field.key, n++)
      stepOf.set(field.key, si)
    }
  })
  const keep = (
    g: FormConditionGroup,
    ok: (key: string) => boolean,
  ): FormConditionGroup => ({
    logic: g.logic,
    rules: g.rules
      .map((r) => ("logic" in r ? keep(r, ok) : r))
      .filter((r) => ("logic" in r ? true : ok(r.fieldKey))),
  })
  return {
    ...def,
    steps: def.steps.map((step, si) => ({
      ...step,
      visibleWhen: step.visibleWhen
        ? keep(step.visibleWhen, (key) => (stepOf.get(key) ?? -1) < si)
        : undefined,
      fields: step.fields.map((field) => ({
        ...field,
        visibleWhen: field.visibleWhen
          ? keep(
              field.visibleWhen,
              (key) => (order.get(key) ?? -1) < (order.get(field.key) ?? -1),
            )
          : undefined,
      })),
    })),
  }
}

export function moveStep(
  def: FormDefinition,
  from: number,
  to: number,
): FormDefinition {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= def.steps.length ||
    to >= def.steps.length
  ) {
    return def
  }
  const steps = [...def.steps]
  const [moved] = steps.splice(from, 1)
  steps.splice(to, 0, moved)
  // A skip rule that now points backwards is dropped rather than left invalid.
  const index = new Map(steps.map((s, i) => [s.id, i]))
  return dropForwardReferences({
    ...def,
    steps,
    rules: def.rules.filter(
      (r) =>
        r.action.type !== "skip_to_step" ||
        (index.get(r.action.toStepId) ?? -1) >
          (index.get(r.action.fromStepId) ?? -1),
    ),
  })
}

export function addField(
  def: FormDefinition,
  stepId: string,
  field: FormField,
  atIndex?: number,
): FormDefinition {
  return {
    ...def,
    steps: def.steps.map((s) => {
      if (s.id !== stepId || s.fields.length >= MAX_FORM_FIELDS_PER_STEP) {
        return s
      }
      const fields = [...s.fields]
      fields.splice(atIndex ?? fields.length, 0, field)
      return { ...s, fields }
    }),
  }
}

export function updateField(
  def: FormDefinition,
  key: string,
  patch: Partial<Omit<FormField, "key">>,
): FormDefinition {
  return {
    ...def,
    steps: def.steps.map((s) => ({
      ...s,
      fields: s.fields.map((f) => (f.key === key ? { ...f, ...patch } : f)),
    })),
  }
}

/** Change a field's key everywhere it is referenced (conditions, rules). */
export function renameFieldKey(
  def: FormDefinition,
  from: string,
  to: string,
): FormDefinition {
  if (from === to || !FORM_FIELD_KEY_REGEX.test(to) || takenKeys(def).has(to)) {
    return def
  }
  const renameGroup = (g: FormConditionGroup): FormConditionGroup => ({
    logic: g.logic,
    rules: g.rules.map((r) => {
      if ("logic" in r) {
        return renameGroup(r)
      }
      return r.fieldKey === from ? { ...r, fieldKey: to } : r
    }),
  })
  return {
    steps: def.steps.map((s) => ({
      ...s,
      visibleWhen: s.visibleWhen ? renameGroup(s.visibleWhen) : undefined,
      fields: s.fields.map((f) => ({
        ...f,
        key: f.key === from ? to : f.key,
        visibleWhen: f.visibleWhen ? renameGroup(f.visibleWhen) : undefined,
      })),
    })),
    rules: def.rules.map((r) => ({
      ...r,
      when: renameGroup(r.when),
      action:
        r.action.type !== "skip_to_step" && r.action.fieldKey === from
          ? { ...r.action, fieldKey: to }
          : r.action,
    })),
  }
}

/** Removing a field also removes the conditions and rules that read or target it. */
export function removeField(def: FormDefinition, key: string): FormDefinition {
  return dropReferences(
    {
      ...def,
      steps: def.steps.map((s) => ({
        ...s,
        fields: s.fields.filter((f) => f.key !== key),
      })),
    },
    key,
  )
}

const pruneGroup = (
  g: FormConditionGroup,
  key: string,
): FormConditionGroup => ({
  logic: g.logic,
  rules: g.rules
    .map((r) => ("logic" in r ? pruneGroup(r, key) : r))
    .filter((r) => ("logic" in r ? true : r.fieldKey !== key)),
})

function dropReferences(def: FormDefinition, key: string): FormDefinition {
  const prune = (g: FormConditionGroup | undefined) =>
    g ? pruneGroup(g, key) : undefined
  return {
    steps: def.steps.map((s) => ({
      ...s,
      visibleWhen: prune(s.visibleWhen),
      fields: s.fields.map((f) => ({
        ...f,
        visibleWhen: prune(f.visibleWhen),
      })),
    })),
    rules: def.rules
      .filter(
        (r) => r.action.type === "skip_to_step" || r.action.fieldKey !== key,
      )
      .map((r) => ({ ...r, when: pruneGroup(r.when, key) })),
  }
}

export function moveField(
  def: FormDefinition,
  stepId: string,
  from: number,
  to: number,
): FormDefinition {
  const step = def.steps.find((s) => s.id === stepId)
  if (
    !step ||
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= step.fields.length ||
    to >= step.fields.length
  ) {
    return def
  }
  const fields = [...step.fields]
  const [moved] = fields.splice(from, 1)
  fields.splice(to, 0, moved)
  return dropForwardReferences({
    ...def,
    steps: def.steps.map((s) => (s.id === stepId ? { ...s, fields } : s)),
  })
}

export function addRule(def: FormDefinition, rule: FormRule): FormDefinition {
  if (def.rules.length >= MAX_FORM_RULES) {
    return def
  }
  return { ...def, rules: [...def.rules, rule] }
}

export function updateRule(
  def: FormDefinition,
  id: string,
  patch: Partial<Omit<FormRule, "id">>,
): FormDefinition {
  return {
    ...def,
    rules: def.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
  }
}

export function removeRule(def: FormDefinition, id: string): FormDefinition {
  return { ...def, rules: def.rules.filter((r) => r.id !== id) }
}

export function uniqueRuleId(def: FormDefinition): string {
  const taken = new Set(def.rules.map((r) => r.id))
  for (let n = def.rules.length + 1; n < 1000; n++) {
    if (!taken.has(`rule-${n}`)) {
      return `rule-${n}`
    }
  }
  return `rule-${Date.now().toString(36)}`
}

/**
 * Input fields a FIELD condition may read: those placed before it in document
 * order (the evaluator resolves in order; a later field reads as undefined).
 */
export function conditionSourcesBefore(
  def: FormDefinition,
  fieldKey: string,
): FormField[] {
  const out: FormField[] = []
  for (const step of def.steps) {
    for (const field of step.fields) {
      if (field.key === fieldKey) {
        return out
      }
      if (isFormInputFieldType(field.type)) {
        out.push(field)
      }
    }
  }
  return out
}

/** Input fields a condition may read, in step order (display blocks excluded). */
export function conditionSources(def: FormDefinition): FormField[] {
  const out: FormField[] = []
  for (const step of def.steps) {
    for (const field of step.fields) {
      if (isFormInputFieldType(field.type)) {
        out.push(field)
      }
    }
  }
  return out
}
