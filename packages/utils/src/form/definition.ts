import { z } from "zod"

/**
 * Web form definition (roadmap forms, s200). Lives in the generic-utils
 * package for the same reason `custom-field.ts` does: the builder editor, the
 * public form page (client) and the submit route (server) all parse and
 * evaluate the SAME definition, and the client half cannot import the
 * database package. `@chatbotx.io/database/partials` re-exports this.
 *
 * Shape (ported from sober-af-forms + bakery_suite, s195 audit):
 *   steps[] -> fields[]; a field or a step carries `visibleWhen`, a nested
 *   AND/OR condition group; form-level `rules[]` show / hide / require /
 *   optional a field or skip forward to a step.
 *
 * Everything caller-supplied has a cap and the condition tree has a depth
 * cap, so a hostile definition can neither blow the row nor recurse the
 * evaluator.
 */

export const MAX_FORM_STEPS = 20
export const MAX_FORM_FIELDS_PER_STEP = 50
export const MAX_FORM_OPTIONS = 50
export const MAX_FORM_RULES = 50
export const MAX_FORM_RULES_PER_GROUP = 20
/** Groups nested inside groups: `nest(4)` parses, `nest(5)` is refused. */
export const MAX_FORM_CONDITION_DEPTH = 4
export const MAX_FORM_DEFINITION_BYTES = 65_536
export const MAX_FORM_LABEL = 120
export const MAX_FORM_TEXT = 500
export const MAX_FORM_VALUE = 2000

export const FORM_FIELD_KEY_REGEX = /^[a-z][a-z0-9_]{0,39}$/
export const FORM_STEP_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,39}$/

export const formConditionOps = z.enum([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "is_empty",
  "is_not_empty",
])
export type FormConditionOp = z.infer<typeof formConditionOps>

export const formInputFieldTypes = z.enum([
  "text",
  "textarea",
  "email",
  "phone",
  "url",
  "number",
  "hidden",
  "select",
  "radio",
  "checkbox",
  "checkboxGroup",
  "date",
  "datetime",
  "time",
])
export type FormInputFieldType = z.infer<typeof formInputFieldTypes>

export const formDisplayFieldTypes = z.enum(["heading", "paragraph", "divider"])
export type FormDisplayFieldType = z.infer<typeof formDisplayFieldTypes>

export const webFormFieldTypes = z.enum([
  ...formInputFieldTypes.options,
  ...formDisplayFieldTypes.options,
])
export type WebFormFieldType = z.infer<typeof webFormFieldTypes>

export const isFormInputFieldType = (
  type: WebFormFieldType,
): type is FormInputFieldType =>
  (formInputFieldTypes.options as readonly string[]).includes(type)

/** Field types whose value is a list of option values. */
export const FORM_LIST_FIELD_TYPES: ReadonlySet<WebFormFieldType> = new Set([
  "checkboxGroup",
])
/** Field types that must carry `options`. */
export const FORM_OPTION_FIELD_TYPES: ReadonlySet<WebFormFieldType> = new Set([
  "select",
  "radio",
  "checkboxGroup",
])

export const formSystemFieldKeys = z.enum([
  "firstName",
  "lastName",
  "email",
  "phoneNumber",
])
export type FormSystemFieldKey = z.infer<typeof formSystemFieldKeys>

export const formFieldMapTo = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("custom"), customFieldId: z.string().min(1) }),
  z.object({ kind: z.literal("system"), key: formSystemFieldKeys }),
])
export type FormFieldMapTo = z.infer<typeof formFieldMapTo>

export const formConditionRule = z
  .object({
    fieldKey: z.string().regex(FORM_FIELD_KEY_REGEX),
    op: formConditionOps,
    value: z
      .union([z.string().max(MAX_FORM_TEXT), z.number(), z.boolean()])
      .optional(),
  })
  .strict()
export type FormConditionRule = z.infer<typeof formConditionRule>

export type FormConditionGroup = {
  logic: "AND" | "OR"
  rules: (FormConditionRule | FormConditionGroup)[]
}

export const isFormConditionGroup = (
  node: FormConditionRule | FormConditionGroup,
): node is FormConditionGroup => "logic" in node

/** Depth of a group: a group with no nested group is depth 1. */
export function formConditionDepth(group: FormConditionGroup): number {
  let deepest = 0
  for (const rule of group.rules) {
    if (isFormConditionGroup(rule)) {
      deepest = Math.max(deepest, formConditionDepth(rule))
    }
  }
  return deepest + 1
}

const formConditionGroupNode: z.ZodType<FormConditionGroup> = z.lazy(() =>
  z
    .object({
      logic: z.enum(["AND", "OR"]),
      rules: z
        .array(z.union([formConditionRule, formConditionGroupNode]))
        .max(MAX_FORM_RULES_PER_GROUP),
    })
    .strict(),
)

export const formConditionGroup = formConditionGroupNode.superRefine(
  (group, ctx) => {
    if (formConditionDepth(group) > MAX_FORM_CONDITION_DEPTH) {
      ctx.addIssue({
        code: "custom",
        message: `Conditions may nest at most ${MAX_FORM_CONDITION_DEPTH} levels deep.`,
      })
    }
  },
)

export const formFieldOption = z
  .object({
    value: z.string().min(1).max(MAX_FORM_LABEL),
    label: z.string().min(1).max(MAX_FORM_LABEL),
  })
  .strict()
export type FormFieldOption = z.infer<typeof formFieldOption>

export const formField = z
  .object({
    key: z.string().regex(FORM_FIELD_KEY_REGEX),
    type: webFormFieldTypes,
    label: z.string().max(MAX_FORM_LABEL).default(""),
    placeholder: z.string().max(MAX_FORM_TEXT).optional(),
    helpText: z.string().max(MAX_FORM_TEXT).optional(),
    required: z.boolean().default(false),
    options: z.array(formFieldOption).max(MAX_FORM_OPTIONS).optional(),
    defaultValue: z.string().max(MAX_FORM_TEXT).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    pattern: z.string().max(MAX_FORM_TEXT).optional(),
    mapTo: formFieldMapTo.optional(),
    visibleWhen: formConditionGroup.optional(),
  })
  .strict()
  .superRefine((field, ctx) => {
    const wantsOptions = FORM_OPTION_FIELD_TYPES.has(field.type)
    if (wantsOptions && (field.options?.length ?? 0) === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: `A ${field.type} field needs at least one option.`,
      })
    }
    if (!wantsOptions && field.options !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: `A ${field.type} field cannot carry options.`,
      })
    }
    if (field.options) {
      const seen = new Set<string>()
      for (const [i, option] of field.options.entries()) {
        if (seen.has(option.value)) {
          ctx.addIssue({
            code: "custom",
            path: ["options", i, "value"],
            message: `Duplicate option value "${option.value}".`,
          })
        }
        seen.add(option.value)
      }
    }
    if (!isFormInputFieldType(field.type) && (field.required || field.mapTo)) {
      ctx.addIssue({
        code: "custom",
        path: ["type"],
        message: `A ${field.type} block cannot be required or mapped.`,
      })
    }
    if (field.pattern !== undefined) {
      try {
        new RegExp(field.pattern)
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["pattern"],
          message: "Invalid pattern.",
        })
      }
    }
    if (
      field.min !== undefined &&
      field.max !== undefined &&
      field.min > field.max
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["max"],
        message: "max must be >= min.",
      })
    }
  })
export type FormField = z.infer<typeof formField>

export const formStep = z
  .object({
    id: z.string().regex(FORM_STEP_ID_REGEX),
    title: z.string().max(MAX_FORM_LABEL).default(""),
    description: z.string().max(MAX_FORM_TEXT).optional(),
    fields: z.array(formField).max(MAX_FORM_FIELDS_PER_STEP),
    visibleWhen: formConditionGroup.optional(),
  })
  .strict()
export type FormStep = z.infer<typeof formStep>

export const formRuleAction = z.discriminatedUnion("type", [
  z
    .object({
      type: z.enum(["show", "hide", "require", "optional"]),
      fieldKey: z.string().regex(FORM_FIELD_KEY_REGEX),
    })
    .strict(),
  z
    .object({
      type: z.literal("skip_to_step"),
      fromStepId: z.string().regex(FORM_STEP_ID_REGEX),
      toStepId: z.string().regex(FORM_STEP_ID_REGEX),
    })
    .strict(),
])
export type FormRuleAction = z.infer<typeof formRuleAction>

export const formRule = z
  .object({
    id: z.string().regex(FORM_STEP_ID_REGEX),
    when: formConditionGroup,
    action: formRuleAction,
  })
  .strict()
export type FormRule = z.infer<typeof formRule>

const collectRuleKeys = (
  group: FormConditionGroup,
  into: string[],
): string[] => {
  for (const rule of group.rules) {
    if (isFormConditionGroup(rule)) {
      collectRuleKeys(rule, into)
    } else {
      into.push(rule.fieldKey)
    }
  }
  return into
}

export const formDefinition = z
  .object({
    steps: z.array(formStep).max(MAX_FORM_STEPS),
    rules: z.array(formRule).max(MAX_FORM_RULES).default([]),
  })
  .strict()
  .superRefine((def, ctx) => {
    const inputKeys = new Set<string>()
    const seenKeys = new Set<string>()
    const stepIds = new Set<string>()
    const stepIndex = new Map<string, number>()
    const systemKeys = new Set<string>()
    const customIds = new Set<string>()
    const conditionRefs: { path: (string | number)[]; key: string }[] = []

    for (const [s, step] of def.steps.entries()) {
      if (stepIds.has(step.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", s, "id"],
          message: `Duplicate step id "${step.id}".`,
        })
      }
      stepIds.add(step.id)
      stepIndex.set(step.id, s)
      if (step.visibleWhen) {
        for (const key of collectRuleKeys(step.visibleWhen, [])) {
          conditionRefs.push({ path: ["steps", s, "visibleWhen"], key })
        }
      }
      for (const [f, field] of step.fields.entries()) {
        if (seenKeys.has(field.key)) {
          ctx.addIssue({
            code: "custom",
            path: ["steps", s, "fields", f, "key"],
            message: `Duplicate field key "${field.key}".`,
          })
        }
        seenKeys.add(field.key)
        if (isFormInputFieldType(field.type)) {
          inputKeys.add(field.key)
        }
        if (field.mapTo?.kind === "system") {
          if (systemKeys.has(field.mapTo.key)) {
            ctx.addIssue({
              code: "custom",
              path: ["steps", s, "fields", f, "mapTo"],
              message: `Contact field "${field.mapTo.key}" is mapped twice.`,
            })
          }
          systemKeys.add(field.mapTo.key)
        }
        if (field.mapTo?.kind === "custom") {
          if (customIds.has(field.mapTo.customFieldId)) {
            ctx.addIssue({
              code: "custom",
              path: ["steps", s, "fields", f, "mapTo"],
              message: "This custom field is mapped twice.",
            })
          }
          customIds.add(field.mapTo.customFieldId)
        }
        if (field.visibleWhen) {
          for (const key of collectRuleKeys(field.visibleWhen, [])) {
            conditionRefs.push({
              path: ["steps", s, "fields", f, "visibleWhen"],
              key,
            })
          }
        }
      }
    }

    for (const [r, rule] of def.rules.entries()) {
      for (const key of collectRuleKeys(rule.when, [])) {
        conditionRefs.push({ path: ["rules", r, "when"], key })
      }
      const action = rule.action
      if (action.type === "skip_to_step") {
        const from = stepIndex.get(action.fromStepId)
        const to = stepIndex.get(action.toStepId)
        if (from === undefined || to === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["rules", r, "action"],
            message: "skip_to_step names a step that does not exist.",
          })
        } else if (to <= from) {
          ctx.addIssue({
            code: "custom",
            path: ["rules", r, "action"],
            message: "skip_to_step may only jump forward.",
          })
        }
      } else if (!inputKeys.has(action.fieldKey)) {
        ctx.addIssue({
          code: "custom",
          path: ["rules", r, "action", "fieldKey"],
          message: `Rule targets unknown input field "${action.fieldKey}".`,
        })
      }
    }

    for (const ref of conditionRefs) {
      if (!inputKeys.has(ref.key)) {
        ctx.addIssue({
          code: "custom",
          path: ref.path,
          message: `Condition reads unknown input field "${ref.key}".`,
        })
      }
    }

    let bytes = 0
    try {
      bytes = new TextEncoder().encode(JSON.stringify(def)).length
    } catch {
      ctx.addIssue({ code: "custom", message: "Definition is not JSON." })
      return
    }
    if (bytes > MAX_FORM_DEFINITION_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `Definition exceeds ${MAX_FORM_DEFINITION_BYTES} bytes.`,
      })
    }
  })
export type FormDefinition = z.infer<typeof formDefinition>
export type FormDefinitionInput = z.input<typeof formDefinition>

export const EMPTY_FORM_DEFINITION: FormDefinition = { steps: [], rules: [] }

/** Every input field of a definition, in step order. */
export function formInputFields(def: FormDefinition): FormField[] {
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

/** True when any field writes to the contact (system or custom). */
export function formMapsToContact(def: FormDefinition): boolean {
  return formInputFields(def).some((f) => f.mapTo !== undefined)
}

/**
 * True when the form can IDENTIFY a contact: a phone or email answer mapped
 * to the matching system field. A form that maps other fields but cannot
 * identify anyone can never resolve a contact and is refused at publish.
 */
export function formIdentifiesContact(def: FormDefinition): boolean {
  return formInputFields(def).some(
    (f) =>
      f.mapTo?.kind === "system" &&
      (f.mapTo.key === "email" || f.mapTo.key === "phoneNumber"),
  )
}
