import z from "zod"

/**
 * Deal pipeline partials: the enums shared by the schema, the business layer,
 * the flow steps and the public API. Phase 1 = pipelines, stages, deals and
 * their activity log. Tasks, dependencies, comments with mentions and
 * per-pipeline members (round-robin) are phase 2 and get their own tables then.
 */

export const dealStatuses = z.enum(["open", "won", "lost"])
export type DealStatus = z.infer<typeof dealStatuses>

export const dealPriorities = z.enum(["low", "medium", "high"])
export type DealPriority = z.infer<typeof dealPriorities>

export const dealActivityTypes = z.enum([
  "created",
  "stageMoved",
  "valueChanged",
  "statusChanged",
  "priorityChanged",
  "assigned",
  "note",
  // phase 2 (s192): every other edit leaves a trail too
  "titleChanged",
  "currencyChanged",
  "dueAtChanged",
  "fieldChanged",
  // phase 2 part 2 (s192): tasks on the deal leave a trail too
  "taskCreated",
  "taskCompleted",
  // phase 2 part 3b (s193): a comment (with its @mentions) leaves a trail
  "commented",
  // s195 CRM 360: the deal's contact / company can be re-linked after creation
  "contactChanged",
  "companyChanged",
])
export type DealActivityType = z.infer<typeof dealActivityTypes>

export const dealTaskStatuses = z.enum(["open", "done"])
export type DealTaskStatus = z.infer<typeof dealTaskStatuses>

/** Who a task template assigns its task to when a deal enters the stage. */
export const dealTaskAssignTo = z.enum(["none", "dealOwner", "user"])
export type DealTaskAssignTo = z.infer<typeof dealTaskAssignTo>

export const MAX_DEAL_TASKS_PER_DEAL = 200
export const MAX_DEAL_TASK_DEPENDENCIES_PER_TASK = 20
export const MAX_DEAL_TASK_TEMPLATES_PER_STAGE = 20
export const MAX_DEAL_TASK_TITLE_LENGTH = 200
export const MAX_DEAL_TASK_DESCRIPTION_LENGTH = 2000
export const MAX_DEAL_TASK_DUE_IN_DAYS = 365

/** When a deal in this pipeline stops the contact's company (`stopCompany({reason: 'deal'})`). */
export const pipelineStopCompanyOn = z.enum(["none", "created", "won"])
export type PipelineStopCompanyOn = z.infer<typeof pipelineStopCompanyOn>

/**
 * Who owns a deal created WITHOUT an explicit `ownerId` (s193): `none` leaves
 * it ownerless, `roundRobin` walks the pipeline's in-rotation members under
 * the pipeline row lock (`Pipeline.roundRobinLastUserId` is the cursor).
 */
export const pipelineAssignOwner = z.enum(["none", "roundRobin"])
export type PipelineAssignOwner = z.infer<typeof pipelineAssignOwner>

/**
 * Who can see the pipeline and its deals (s193): `workspace` = every member
 * with contacts access, `members` = only PipelineMember rows (a super admin
 * always sees it). A member with `onlyAssignedContacts` additionally sees
 * only the deals they own, whatever the access mode.
 */
export const pipelineAccess = z.enum(["workspace", "members"])
export type PipelineAccess = z.infer<typeof pipelineAccess>

export const MAX_PIPELINE_MEMBERS = 50

/** Deal comments (s193 part 3b): body cap, mentions per comment, comments per deal. */
export const MAX_DEAL_COMMENT_CHARS = 4000
export const MAX_DEAL_COMMENT_MENTIONS = 20
export const MAX_DEAL_COMMENTS_PER_DEAL = 1000

export const DEFAULT_DEAL_CURRENCY = "USD"

/** Value types a custom deal field can declare (mirrors the contact custom-field kinds we need). */
export const dealFieldTypes = z.enum([
  "shortText",
  "longText",
  "number",
  "date",
  "boolean",
  "select",
])
export type DealFieldType = z.infer<typeof dealFieldTypes>

export const DEAL_FIELD_KEY = /^[a-z][a-zA-Z0-9_]{0,39}$/
export const MAX_DEAL_FIELD_DEFS = 30
export const MAX_DEAL_FIELD_OPTIONS = 50
/** Caps on the free-form `Deal.fields` jsonb: keys and serialised bytes. */
export const MAX_DEAL_FIELD_KEYS = 50
export const MAX_DEAL_FIELDS_BYTES = 8 * 1024

/**
 * One custom deal field, declared per pipeline in `Pipeline.settings.fieldDefs`.
 * Closed: an unknown key here is a caller bug, not a forward-compat feature.
 */
export const dealFieldDefSchema = z
  .object({
    key: z.string().regex(DEAL_FIELD_KEY, "camelCase key, max 40 chars"),
    label: z.string().trim().min(1).max(60),
    type: dealFieldTypes,
    options: z
      .array(z.string().trim().min(1).max(60))
      .max(MAX_DEAL_FIELD_OPTIONS)
      .optional(),
    required: z.boolean().default(false),
  })
  .strict()
  .superRefine((def, ctx) => {
    if (def.type === "select") {
      if (!def.options || def.options.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["options"],
          message: "A select field needs at least one option.",
        })
      } else if (new Set(def.options).size !== def.options.length) {
        ctx.addIssue({
          code: "custom",
          path: ["options"],
          message: "Options must be unique.",
        })
      }
    } else if (def.options !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "Only a select field takes options.",
      })
    }
  })
export type DealFieldDef = z.infer<typeof dealFieldDefSchema>
export type DealFieldDefInput = z.input<typeof dealFieldDefSchema>

export const dealFieldDefsSchema = z
  .array(dealFieldDefSchema)
  .max(MAX_DEAL_FIELD_DEFS)
  .superRefine((defs, ctx) => {
    const seen = new Set<string>()
    for (const [index, def] of defs.entries()) {
      if (seen.has(def.key)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "key"],
          message: `Duplicate field key "${def.key}".`,
        })
      }
      seen.add(def.key)
    }
  })

export const pipelineSettingsSchema = z.object({
  stopCompanyOn: pipelineStopCompanyOn.default("created"),
  defaultCurrency: z
    .string()
    .trim()
    .length(3)
    .toUpperCase()
    .default(DEFAULT_DEAL_CURRENCY),
  // Rows written before s192 have no key: the default makes them parse.
  fieldDefs: dealFieldDefsSchema.default([]),
  // s193: both default so pre-s193 rows parse (hotfix #27 rule).
  assignOwner: pipelineAssignOwner.default("none"),
  access: pipelineAccess.default("workspace"),
})
export type PipelineSettings = z.infer<typeof pipelineSettingsSchema>
export type PipelineSettingsInput = z.input<typeof pipelineSettingsSchema>

export const DEFAULT_PIPELINE_SETTINGS: PipelineSettings = {
  stopCompanyOn: "created",
  defaultCurrency: DEFAULT_DEAL_CURRENCY,
  fieldDefs: [],
  assignOwner: "none",
  access: "workspace",
}

export type DealFieldIssue = { key: string; message: string }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/

function checkFieldValue(def: DealFieldDef, value: unknown): string | null {
  if (value === null) {
    return def.required ? "is required" : null
  }
  switch (def.type) {
    case "shortText":
      return typeof value === "string" && value.length <= 255
        ? null
        : "must be text of at most 255 characters"
    case "longText":
      return typeof value === "string" && value.length <= 4000
        ? null
        : "must be text of at most 4000 characters"
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : "must be a finite number"
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false"
    case "date":
      return typeof value === "string" && ISO_DATE.test(value)
        ? null
        : "must be an ISO date"
    case "select":
      return typeof value === "string" && (def.options ?? []).includes(value)
        ? null
        : `must be one of ${(def.options ?? []).join(", ")}`
    default:
      return "has an unknown type"
  }
}

/**
 * Validate a `Deal.fields` object against a pipeline's `fieldDefs`. Declared
 * keys are type-checked (a select value must be an option, `null` clears);
 * undeclared keys stay free-form (the public API documents them so) but the
 * whole object is capped at MAX_DEAL_FIELD_KEYS keys / MAX_DEAL_FIELDS_BYTES.
 * `requireAll` (create) also flags a missing required key. Returns the issue
 * list; empty = valid. A non-object input is one issue on key "fields".
 */
export function validateDealFields(props: {
  defs: readonly DealFieldDef[] | null | undefined
  fields: unknown
  requireAll?: boolean
}): DealFieldIssue[] {
  const { fields, requireAll = false } = props
  const defs = props.defs ?? []
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    return [{ key: "fields", message: "must be an object" }]
  }
  const record = fields as Record<string, unknown>
  const keys = Object.keys(record)
  const issues: DealFieldIssue[] = []
  if (keys.length > MAX_DEAL_FIELD_KEYS) {
    issues.push({
      key: "fields",
      message: `has more than ${MAX_DEAL_FIELD_KEYS} keys`,
    })
  }
  let bytes = 0
  try {
    bytes = new TextEncoder().encode(JSON.stringify(record)).length
  } catch {
    return [{ key: "fields", message: "is not JSON-serialisable" }]
  }
  if (bytes > MAX_DEAL_FIELDS_BYTES) {
    issues.push({
      key: "fields",
      message: `exceeds ${MAX_DEAL_FIELDS_BYTES} bytes`,
    })
  }
  for (const def of defs) {
    const present = Object.hasOwn(record, def.key)
    if (!present) {
      if (requireAll && def.required) {
        issues.push({ key: def.key, message: "is required" })
      }
      continue
    }
    const message = checkFieldValue(def, record[def.key])
    if (message) {
      issues.push({ key: def.key, message })
    }
  }
  return issues
}

/** The stages `pipelineService.create` seeds when none are given. */
export const DEFAULT_PIPELINE_STAGES = [
  {
    name: "New",
    color: "#64748b",
    probability: 10,
    isWon: false,
    isLost: false,
  },
  {
    name: "Qualified",
    color: "#3b82f6",
    probability: 50,
    isWon: false,
    isLost: false,
  },
  {
    name: "Won",
    color: "#22c55e",
    probability: 100,
    isWon: true,
    isLost: false,
  },
  {
    name: "Lost",
    color: "#ef4444",
    probability: 0,
    isWon: false,
    isLost: true,
  },
] as const

const MONEY_SEPARATORS = /[,\s_]/g

/** Money is stored as numeric(14,2); the app always compares the normalised string. */
export const DEAL_VALUE_SCALE = 2

/**
 * Normalise a money input to the exact string the database returns for
 * numeric(14,2), or null when the input is not a finite non-negative number.
 * Accepts "1,250.50", "1250.5", 1250.5; rejects "abc", NaN, negatives.
 */
export function normalizeDealValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null
  }
  let asNumber = Number.NaN
  if (typeof value === "number") {
    asNumber = value
  } else if (typeof value === "string") {
    asNumber = Number(value.replace(MONEY_SEPARATORS, ""))
  }
  if (!Number.isFinite(asNumber) || asNumber < 0 || asNumber >= 1e12) {
    return null
  }
  return asNumber.toFixed(DEAL_VALUE_SCALE)
}
