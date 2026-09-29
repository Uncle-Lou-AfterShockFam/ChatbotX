import { z } from "zod"
import { isOptionFieldType } from "../custom-field"
import { isHttpsUrl } from "./url"

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
 * One definition, two channels (s219, owner): the same form runs on the web
 * page and question by question in chat. `image` / `file` / `location` are
 * CHAT-ONLY until the web page grows upload fields (publish refuses them on a
 * web form); `chat` carries the per-field prompt / retry / media a chat run
 * sends, and option `points` score an answer.
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
/** s220c A2-4: a rating is 1..max stars, max between these (default 5). */
export const FORM_RATING_MIN_STARS = 3
export const FORM_RATING_MAX_STARS = 10
export const FORM_RATING_DEFAULT_STARS = 5
export const MAX_FORM_PATTERN = 200
export const MAX_FORM_OPTION_POINTS = 1000

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
  "slider",
  "rating",
  "hidden",
  "select",
  "radio",
  "checkbox",
  "checkboxGroup",
  "date",
  "datetime",
  "time",
  "image",
  "file",
  "location",
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
/**
 * Answered by sending something in chat (a photo, a file, a shared
 * location); the web page cannot render them yet, so a form that runs on the
 * web may not contain them.
 */
export const FORM_CHAT_ONLY_FIELD_TYPES: ReadonlySet<WebFormFieldType> =
  new Set(["image", "file", "location"])
/** s220c A2-4: answered with a number on a bounded scale (slider, rating). */
export const FORM_SCALE_FIELD_TYPES: ReadonlySet<WebFormFieldType> = new Set([
  "slider",
  "rating",
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
  "fullName",
])
export type FormSystemFieldKey = z.infer<typeof formSystemFieldKeys>

export const formFieldMapTo = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("custom"),
    customFieldId: z.string().regex(/^\d{1,19}$/),
  }),
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

/**
 * A group schema that admits nested groups only `depth` more levels. Built
 * per level instead of one `z.lazy`, so the PARSER refuses depth 5 before
 * recursing: a `superRefine` after a full recursive parse let a 4,534-deep
 * body throw RangeError instead of returning a failure (blind probe, s200).
 */
const groupSchemaAt = (depth: number): z.ZodType<FormConditionGroup> =>
  z
    .object({
      logic: z.enum(["AND", "OR"]),
      rules: z
        .array(
          depth >= MAX_FORM_CONDITION_DEPTH
            ? formConditionRule
            : z.union([formConditionRule, groupSchemaAt(depth + 1)]),
        )
        .max(MAX_FORM_RULES_PER_GROUP),
    })
    .strict() as unknown as z.ZodType<FormConditionGroup>

export const formConditionGroup = groupSchemaAt(1)

/**
 * `pattern` is a caller-supplied regex run against submitted text, so it may
 * not carry the shapes that make V8 backtrack exponentially: a quantified
 * group whose body is itself quantified (`(a+)+`), alternation inside a
 * quantified group (`(a|aa)+`), or a backreference. Measured before the
 * guard: `(a+)+$` on 29 chars took 35 s (blind probe, s200).
 */
const BACKREFERENCE = /\\[1-9]/
/** `*`, `+` or `{n,}` right after a group: the group repeats without bound. */
const UNBOUNDED_AFTER_GROUP = /\)(?:[*+]|\{\d+,\})/
/** An unbounded quantifier or an alternation inside a group body. */
const UNBOUNDED_OR_ALTERNATION_IN_BODY = /[*+|]|\{\d+,\}/

export function isSafeFormPattern(pattern: string): boolean {
  if (pattern.length > MAX_FORM_PATTERN || BACKREFERENCE.test(pattern)) {
    return false
  }
  try {
    new RegExp(pattern, "u")
  } catch {
    return false
  }
  if (!UNBOUNDED_AFTER_GROUP.test(pattern)) {
    return true
  }
  // Walk each unboundedly-quantified group; refuse when its body repeats or alternates.
  const stack: number[] = []
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === "\\") {
      i++
      continue
    }
    if (ch === "(") {
      stack.push(i)
    } else if (ch === ")") {
      const start = stack.pop()
      if (
        start !== undefined &&
        UNBOUNDED_AFTER_GROUP.test(pattern.slice(i, i + 12)) &&
        UNBOUNDED_OR_ALTERNATION_IN_BODY.test(pattern.slice(start + 1, i))
      ) {
        return false
      }
    }
  }
  return true
}

export const formFieldOption = z
  .object({
    value: z.string().min(1).max(MAX_FORM_LABEL),
    label: z.string().min(1).max(MAX_FORM_LABEL),
    /** Score earned by choosing this option (a scored questionnaire). */
    points: z
      .number()
      .int()
      .min(-MAX_FORM_OPTION_POINTS)
      .max(MAX_FORM_OPTION_POINTS)
      .optional(),
  })
  .strict()
export type FormFieldOption = z.infer<typeof formFieldOption>

/** What a chat run sends for this field (the web page ignores it). */
export const formFieldChat = z
  .object({
    /** Sent instead of the label when asking in chat. */
    prompt: z.string().min(1).max(MAX_FORM_TEXT).optional(),
    /** Sent when an answer does not validate; a default is used when absent. */
    retryMessage: z.string().min(1).max(MAX_FORM_TEXT).optional(),
    /** An image sent with the question (https only). */
    mediaUrl: z
      .string()
      .max(MAX_FORM_VALUE)
      .refine(isHttpsUrl, "mediaUrl must be an https URL.")
      .optional(),
  })
  .strict()
export type FormFieldChat = z.infer<typeof formFieldChat>

export const MAX_FORM_PROFILE_SUBMISSIONS = 100

/**
 * Progressive profiling (s219 A2-2, Mautic `Field::showForContact`): which
 * fields a KNOWN contact is asked. Only a chat run knows its contact, so the
 * web page ignores these until it can identify the visitor.
 */
export const formFieldProfile = z
  .object({
    /** false = do not ask when the contact already holds this answer. */
    showWhenKnown: z.boolean().optional(),
    /** Ask only once the contact has submitted this form N times. */
    showAfterSubmissions: z
      .number()
      .int()
      .min(0)
      .max(MAX_FORM_PROFILE_SUBMISSIONS)
      .optional(),
    /**
     * Never cut by the `profilingLimit` budget (counted against it first).
     * The two rules above still apply: this bypasses the budget only
     * (Mautic DisplayManager semantics).
     */
    alwaysDisplay: z.boolean().optional(),
  })
  .strict()
export type FormFieldProfile = z.infer<typeof formFieldProfile>

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
    /** `slider` only: the knob's increment from `min` (default 1). */
    step: z.number().positive().optional(),
    pattern: z.string().max(MAX_FORM_PATTERN).optional(),
    mapTo: formFieldMapTo.optional(),
    visibleWhen: formConditionGroup.optional(),
    chat: formFieldChat.optional(),
    profile: formFieldProfile.optional(),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (field.profile && !isFormInputFieldType(field.type)) {
      ctx.addIssue({
        code: "custom",
        path: ["profile"],
        message: `A ${field.type} block asks nothing, so it has no profiling rule.`,
      })
    }
    // s220c A2-4: a slider needs both bounds; a rating is 1..max stars.
    if (field.step !== undefined && field.type !== "slider") {
      ctx.addIssue({
        code: "custom",
        path: ["step"],
        message: "Only a slider has a step.",
      })
    }
    if (field.type === "slider") {
      if (field.min === undefined || field.max === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field.min === undefined ? "min" : "max"],
          message: "A slider needs a minimum and a maximum.",
        })
      } else if (
        field.step !== undefined &&
        field.step > field.max - field.min
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["step"],
          message: "The step is larger than the slider's range.",
        })
      }
    }
    if (field.type === "rating") {
      if (field.min !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["min"],
          message: "A rating always starts at 1.",
        })
      }
      if (
        field.max !== undefined &&
        !(
          Number.isInteger(field.max) &&
          field.max >= FORM_RATING_MIN_STARS &&
          field.max <= FORM_RATING_MAX_STARS
        )
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["max"],
          message: `A rating has ${FORM_RATING_MIN_STARS} to ${FORM_RATING_MAX_STARS} stars.`,
        })
      }
      if (field.defaultValue !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["defaultValue"],
          message: "A rating starts empty (a default would be a vote).",
        })
      }
    }
    if (
      FORM_SCALE_FIELD_TYPES.has(field.type) &&
      field.mapTo?.kind === "system"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["mapTo"],
        message: `A ${field.type} answer can only map to a custom field.`,
      })
    }
    if (FORM_CHAT_ONLY_FIELD_TYPES.has(field.type)) {
      for (const prop of ["pattern", "min", "max", "defaultValue"] as const) {
        if (field[prop] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [prop],
            message: `A ${field.type} field cannot carry ${prop}.`,
          })
        }
      }
      if (field.mapTo?.kind === "system") {
        ctx.addIssue({
          code: "custom",
          path: ["mapTo"],
          message: `A ${field.type} answer can only map to a custom field.`,
        })
      }
    }
    // s220c A2-4: a hidden field's value is its default (applyHiddenDefaults),
    // so a default on a hidden field that IDENTIFIES the contact would attach
    // every submitter to the same contact. Such a field must come from a link.
    if (
      field.type === "hidden" &&
      field.mapTo?.kind === "system" &&
      (field.mapTo.key === "email" || field.mapTo.key === "phoneNumber") &&
      field.defaultValue !== undefined &&
      field.defaultValue !== ""
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultValue"],
        message:
          "A hidden field that identifies the contact (email / phone) cannot have a default: every submission would land on the same contact. Fill it from a link (prefill key) instead.",
      })
    }
    if (!isFormInputFieldType(field.type) && field.chat?.retryMessage) {
      ctx.addIssue({
        code: "custom",
        path: ["chat", "retryMessage"],
        message: `A ${field.type} block asks nothing, so it has no retry message.`,
      })
    }
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
    if (field.pattern !== undefined && !isSafeFormPattern(field.pattern)) {
      ctx.addIssue({
        code: "custom",
        path: ["pattern"],
        message:
          "Pattern is invalid or unsafe (no nested quantifiers, alternation inside a quantified group, or backreferences).",
      })
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

/** Every field key a condition group reads, depth-first (duplicates kept). */
export const collectRuleKeys = (
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
    /** Position of every input key in document order, for the reads-earlier rule. */
    const keyOrder = new Map<string, number>()
    const keyStep = new Map<string, number>()
    let order = 0
    const conditionRefs: {
      path: (string | number)[]
      key: string
      /** A field condition may read keys with a lower order; a step condition keys of earlier steps. */
      before?: { order: number } | { step: number }
    }[] = []

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
          conditionRefs.push({
            path: ["steps", s, "visibleWhen"],
            key,
            before: { step: s },
          })
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
          keyOrder.set(field.key, order)
          keyStep.set(field.key, s)
        }
        const myOrder = order
        order++
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
              before: { order: myOrder },
            })
          }
        }
      }
    }

    // fullName writes first AND last name: mapping it beside either one
    // would let two answers race for the same contact column.
    if (
      systemKeys.has("fullName") &&
      (systemKeys.has("firstName") || systemKeys.has("lastName"))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["steps"],
        message: "Full name cannot be mapped together with first or last name.",
      })
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
        continue
      }
      // The evaluator resolves steps and fields in order, so a condition
      // that reads a LATER field would always see undefined (skeptic, s200).
      const before = ref.before
      if (before === undefined) {
        continue
      }
      const tooLate =
        "order" in before
          ? (keyOrder.get(ref.key) ?? -1) >= before.order
          : (keyStep.get(ref.key) ?? -1) >= before.step
      if (tooLate) {
        ctx.addIssue({
          code: "custom",
          path: ref.path,
          message: `Condition reads "${ref.key}", which comes later in the form; conditions may only read earlier fields.`,
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

/** The chat-only fields of a definition (refused on a web form, s219). */
export function formChatOnlyFields(def: FormDefinition): FormField[] {
  return formInputFields(def).filter((f) =>
    FORM_CHAT_ONLY_FIELD_TYPES.has(f.type),
  )
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

/** Why a form field cannot write to a typed custom field (s201). */
export type FormMappingIssue =
  | { reason: "optionFieldRequired" }
  | { reason: "cardinalityMismatch" }
  | { reason: "unknownOptions"; unknown: string[] }

/**
 * Can this form field write to a custom field of `target.type`? Only an
 * option target is constrained: `select` takes a single-choice form field
 * (select / radio), `multiSelect` takes a checkbox group, and every form
 * option VALUE must be one of the target's options (case-insensitive), so a
 * published form can never submit an answer the field would refuse.
 */
export function formMappingIssue(
  field: Pick<FormField, "type" | "options">,
  target: { type: string; options?: readonly string[] | null },
): FormMappingIssue | null {
  if (!isOptionFieldType(target.type)) {
    return null
  }
  if (!FORM_OPTION_FIELD_TYPES.has(field.type)) {
    return { reason: "optionFieldRequired" }
  }
  const isList = FORM_LIST_FIELD_TYPES.has(field.type)
  if (isList !== (target.type === "multiSelect")) {
    return { reason: "cardinalityMismatch" }
  }
  const known = new Set((target.options ?? []).map((o) => o.toLowerCase()))
  const unknown = (field.options ?? [])
    .map((o) => o.value)
    .filter((v) => !known.has(v.trim().toLowerCase()))
  return unknown.length > 0 ? { reason: "unknownOptions", unknown } : null
}
