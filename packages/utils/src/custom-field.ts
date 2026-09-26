import { z } from "zod"

/**
 * See this package's README ("Exception: cross-cutting product enums") for why
 * a product enum lives in a generic-utils package: `@chatbotx.io/flow-config`
 * needs it for the flow-export custom-field manifest without depending on
 * `@chatbotx.io/database` (database already depends on flow-config).
 *
 * `@chatbotx.io/database/partials` re-exports this, so existing importers there
 * keep working unchanged. Mirrors the `channelTypes` precedent in `./channel.ts`.
 */
export const customFieldTypes = z.enum([
  "shortText",
  "email",
  "phoneNumber",
  "number",
  "date",
  "datetime",
  "boolean",
  "longText",
  "select",
  "multiSelect",
])
export type CustomFieldType = z.infer<typeof customFieldTypes>

/**
 * Bot (account) fields share the Postgres enum but have no option list, so the
 * option types (s201) are excluded from every bot-field write surface.
 */
export const botFieldTypes = customFieldTypes.exclude(["select", "multiSelect"])
export type BotFieldType = z.infer<typeof botFieldTypes>

/**
 * Contact-filter comparison operators. Lives here (not `@chatbotx.io/database`)
 * so a "use client" component (e.g. the filter condition dialog) can read the
 * enum without pulling in the database package. `@chatbotx.io/database/partials`
 * re-exports this for existing backend importers. Mirrors the `channelTypes`
 * precedent in `./channel.ts`.
 */
export const operatorTypes = z.enum([
  "in",
  "notIn",
  "isEmpty",
  "isNotEmpty",
  "eq",
  "ne",
  "startsWith",
  "endsWith",
  "contains",
  "notContains",
  "lt",
  "lte",
  "gt",
  "gte",
  "isBetween",
  "notBetween",
  "used",
])
export type OperatorType = z.infer<typeof operatorTypes>

/**
 * Canonical `(type, name)` identity used to match a flow export's custom-field
 * manifest against the target workspace's existing fields.
 *
 * Case- and whitespace-insensitive: the export carries whatever casing the
 * source workspace used, and an exact-case match would mint a duplicate field
 * on every casing drift. `type` is part of the key because the DB's unique
 * index is on `(workspaceId, type, name)` — two fields may share a name if
 * their types differ.
 *
 * Lives here, beside the enum, because both `customFieldService` (which builds
 * the resolved map) and `flowService` (which looks up into it) must fold keys
 * identically — two private copies would silently diverge and break the
 * lookup.
 */
export const customFieldResolutionKey = (field: {
  name: string
  type: CustomFieldType
}): string => `${field.type}:${field.name.trim().toLowerCase()}`

// Boolean vocabulary = Postgres's own boolean input literals, so a stored
// value is always castable with `::boolean`. Shared by write-side
// normalization (business), the contact-filter SQL guard (database), and
// import/JS validation — one source, no drift.
export const BOOLEAN_TRUTHY_LITERALS = [
  "t",
  "true",
  "y",
  "yes",
  "on",
  "1",
] as const
export const BOOLEAN_FALSY_LITERALS = [
  "f",
  "false",
  "n",
  "no",
  "off",
  "0",
] as const

/** Regex source for the SQL guard: `lower(btrim(value)) ~ '<this>'`. */
export const BOOLEAN_LITERAL_PATTERN_SOURCE = `^(${[
  ...BOOLEAN_TRUTHY_LITERALS,
  ...BOOLEAN_FALSY_LITERALS,
].join("|")})$`

const TRUTHY = new Set<string>(BOOLEAN_TRUTHY_LITERALS)
const FALSY = new Set<string>(BOOLEAN_FALSY_LITERALS)

/** Strict: recognized literal → "true"/"false", anything else → null (callers skip/reject). */
export const canonicalBooleanLiteral = (
  raw: string,
): "true" | "false" | null => {
  const literal = raw.trim().toLowerCase()
  if (TRUTHY.has(literal)) {
    return "true"
  }
  return FALSY.has(literal) ? "false" : null
}

/**
 * Generous: blank/falsy literal → "false", everything else → "true".
 * Never throws — flow/trigger writes carry arbitrary user text and a chatbot
 * must not crash on it.
 */
export const coerceBooleanLiteral = (raw: string): "true" | "false" => {
  const literal = raw.trim().toLowerCase()
  return literal.length === 0 || FALSY.has(literal) ? "false" : "true"
}

/**
 * Number canonicalizer: whatever JS `Number()` accepts ("+1", "1.", "1e3",
 * "0x10") → canonical decimal string ("007" → "7"); blank or non-finite →
 * null (callers decide: throw, skip, or "unset").
 */
export const canonicalNumberLiteral = (raw: string): string | null => {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return null
  }
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? String(parsed) : null
}

// --- Option-list fields (s201): `select` holds one option, `multiSelect` a
// set of them. The option list lives on `CustomField.options`; a stored
// multiSelect value is canonical JSON-array text in option order, e.g.
// `["Gold","Silver"]` (owner decision s201: never comma text, because an
// option may itself contain a comma).

export type OptionFieldType = Extract<CustomFieldType, "select" | "multiSelect">

export const isOptionFieldType = (type: string): type is OptionFieldType =>
  type === "select" || type === "multiSelect"

export const MAX_CUSTOM_FIELD_OPTIONS = 100
export const MAX_CUSTOM_FIELD_OPTION_LENGTH = 60

/** An option list: 1-100 trimmed, non-blank, case-insensitively unique labels. */
export const customFieldOptionsSchema = z
  .array(z.string().trim().min(1).max(MAX_CUSTOM_FIELD_OPTION_LENGTH))
  .min(1)
  .max(MAX_CUSTOM_FIELD_OPTIONS)
  .superRefine((options, ctx) => {
    const seen = new Set<string>()
    for (const [index, option] of options.entries()) {
      const folded = option.toLowerCase()
      if (seen.has(folded)) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: `Duplicate option "${option}".`,
        })
      }
      seen.add(folded)
    }
  })

/**
 * The (type, options) pairing rule, as a message or null: an option type needs
 * an option list, every other type must not carry one.
 */
export const customFieldOptionsIssue = (
  type: string,
  options: unknown,
): string | null => {
  if (!isOptionFieldType(type)) {
    return options === undefined || options === null
      ? null
      : "Only a select or multi-select field takes options."
  }
  if (options === undefined || options === null) {
    return "A select or multi-select field needs at least one option."
  }
  const parsed = customFieldOptionsSchema.safeParse(options)
  return parsed.success
    ? null
    : (parsed.error.issues[0]?.message ?? "Invalid options.")
}

/** Options textarea text -> option list: one per line, trimmed, blanks dropped. */
export const optionsFromText = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

/** zod refine for any object carrying `type` + `options`: the pairing rule. */
export const refineCustomFieldOptions = (
  value: { type: string; options?: unknown },
  ctx: z.RefinementCtx,
): void => {
  const issue = customFieldOptionsIssue(value.type, value.options)
  if (issue) {
    ctx.addIssue({ code: "custom", path: ["options"], message: issue })
  }
}

/** Case-insensitive lookup of the canonical option spelling. */
const matchOption = (
  raw: string,
  options: readonly string[],
): string | undefined => {
  const folded = raw.trim().toLowerCase()
  return options.find((o) => o.toLowerCase() === folded)
}

/** Blank or a known option (canonical spelling); null when unknown. */
export const canonicalSelectValue = (
  raw: string,
  options: readonly string[],
): string | null => {
  if (raw.trim() === "") {
    return ""
  }
  return matchOption(raw, options) ?? null
}

/**
 * Splits a multiSelect input into raw items: a JSON array of strings, or else a
 * comma list. A whole input that is itself one option wins over the comma
 * split, so an option like "Red, White" can be written as plain text.
 * Returns null when the input is a JSON array holding a non-string.
 */
export const splitMultiSelectInput = (
  raw: string,
  options: readonly string[] = [],
): string[] | null => {
  const trimmed = raw.trim()
  if (trimmed === "") {
    return []
  }
  if (trimmed.startsWith("[")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      parsed = undefined
    }
    if (Array.isArray(parsed)) {
      return parsed.every((v) => typeof v === "string") ? parsed : null
    }
  }
  if (matchOption(trimmed, options) !== undefined) {
    return [trimmed]
  }
  return joinCommaOptions(trimmed.split(","), options)
}

/**
 * Re-joins comma-split segments that together spell an option holding a
 * comma, longest match first: "Red, White, Blue" with the option
 * "Red, White" -> ["Red, White", " Blue"] (the display / CSV text of a
 * stored multiSelect round-trips). Bounded: at most MAX_CUSTOM_FIELD_OPTIONS
 * segments are joined (callers cap the item count past that).
 */
const joinCommaOptions = (
  segments: string[],
  options: readonly string[],
): string[] => {
  if (
    segments.length > MAX_CUSTOM_FIELD_OPTIONS ||
    !options.some((o) => o.includes(","))
  ) {
    return segments
  }
  const out: string[] = []
  let i = 0
  while (i < segments.length) {
    let taken = 1
    for (let j = segments.length; j > i + 1; j--) {
      if (matchOption(segments.slice(i, j).join(","), options) !== undefined) {
        taken = j - i
        break
      }
    }
    out.push(segments.slice(i, i + taken).join(","))
    i += taken
  }
  return out
}

export type MultiSelectResult =
  | { ok: true; value: string }
  | { ok: false; reason: "malformed" | "tooManyItems" }
  | { ok: false; reason: "unknownOption"; unknown: string[] }

/**
 * Canonical stored text for a multiSelect write: known options only, deduped,
 * in option-list order, as JSON array text. An empty selection is "" (unset).
 */
export const canonicalMultiSelectValue = (
  raw: string,
  options: readonly string[],
): MultiSelectResult => {
  const items = splitMultiSelectInput(raw, options)
  if (items === null) {
    return { ok: false, reason: "malformed" }
  }
  if (items.length > MAX_CUSTOM_FIELD_OPTIONS) {
    return { ok: false, reason: "tooManyItems" }
  }
  const picked = new Set<string>()
  const unknown: string[] = []
  for (const item of items) {
    if (item.trim() === "") {
      continue
    }
    const match = matchOption(item, options)
    if (match === undefined) {
      unknown.push(item.trim())
    } else {
      picked.add(match)
    }
  }
  if (unknown.length > 0) {
    return { ok: false, reason: "unknownOption", unknown }
  }
  const ordered = options.filter((o) => picked.has(o))
  return {
    ok: true,
    value: ordered.length === 0 ? "" : JSON.stringify(ordered),
  }
}

/** Stored multiSelect text -> its items; legacy non-JSON text is one item. */
export const multiSelectItems = (stored: string): string[] => {
  const trimmed = stored.trim()
  if (trimmed === "") {
    return []
  }
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string")
      }
    } catch {
      // legacy text that merely starts with "["
    }
  }
  return [stored]
}

/** Human text for a stored multiSelect value: "Gold, Silver". */
export const formatMultiSelectText = (stored: string): string =>
  multiSelectItems(stored).join(", ")

// --- Filtering / branching on option fields (s203, PR3b). One table serves
// the builder schema, the SQL builder and the trigger evaluator.

/**
 * Operators an option field accepts. select: `in` / `notIn` = is any / none
 * of. multiSelect: `in` = has any of, `contains` = has all of, `notIn` = has
 * none of, `eq` / `ne` = is / is not exactly this set. A contact with no value
 * matches `ne`, `notIn` and `isEmpty` (the negatives), like every other field.
 */
export const OPTION_FIELD_OPERATORS = {
  select: ["eq", "ne", "in", "notIn", "isEmpty", "isNotEmpty"],
  multiSelect: ["in", "contains", "notIn", "eq", "ne", "isEmpty", "isNotEmpty"],
} as const satisfies Record<OptionFieldType, readonly OperatorType[]>

const isValuelessOptionOperator = (operator: string): boolean =>
  operator === "isEmpty" || operator === "isNotEmpty"

/** A select `eq` / `ne` compares one option; every other valued operator a list. */
export const optionOperatorTakesList = (
  type: OptionFieldType,
  operator: string,
): boolean =>
  !(
    isValuelessOptionOperator(operator) ||
    (type === "select" && (operator === "eq" || operator === "ne"))
  )

/**
 * Why an option-field condition is invalid, or null. Closed: an operator
 * outside {@link OPTION_FIELD_OPERATORS}, a list where one option is expected
 * (or the reverse), an empty / blank / over-long list are all refused.
 */
export const optionConditionIssue = (
  type: OptionFieldType,
  operator: string,
  value: unknown,
): string | null => {
  if (!(OPTION_FIELD_OPERATORS[type] as readonly string[]).includes(operator)) {
    return "Operator is not supported for this field"
  }
  if (isValuelessOptionOperator(operator)) {
    return null
  }
  if (!optionOperatorTakesList(type, operator)) {
    return typeof value === "string" && value.trim() !== ""
      ? null
      : "Operator requires one option"
  }
  if (!Array.isArray(value) || value.length === 0) {
    return "Operator requires at least one option"
  }
  if (value.length > MAX_CUSTOM_FIELD_OPTIONS) {
    return `At most ${MAX_CUSTOM_FIELD_OPTIONS} options`
  }
  return value.every((v) => typeof v === "string" && v.trim() !== "")
    ? null
    : "Options must be non-blank text"
}

/**
 * Stored multiSelect text -> the items a condition compares. Mirrors the SQL
 * builder's `optionItemsSql` exactly (a property test holds them together):
 * blank -> none, a JSON array -> its elements (a non-string element never
 * equals an option), any other text -> one legacy item.
 */
const conditionItems = (stored: string): unknown[] => {
  const trimmed = stored.trim()
  if (trimmed === "") {
    return []
  }
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return parsed
      }
    } catch {
      // legacy text that merely starts with "["
    }
  }
  return [stored]
}

/**
 * JS evaluation of a VALID option-field condition (check
 * {@link optionConditionIssue} first; an unknown operator returns false) over
 * the stored value (null = the contact has no value). Same answers as the SQL
 * builder's option branch.
 */
export const matchesOptionCondition = (
  type: OptionFieldType,
  operator: string,
  stored: string | null | undefined,
  value: unknown,
): boolean => {
  const list = Array.isArray(value) ? (value as string[]) : [String(value)]
  if (type === "select") {
    const present = stored !== null && stored !== undefined && stored !== ""
    switch (operator) {
      case "eq":
        return present && stored === list[0]
      case "ne":
        return !(present && stored === list[0])
      case "in":
        return present && list.includes(stored)
      case "notIn":
        return !(present && list.includes(stored))
      case "isNotEmpty":
        return present
      case "isEmpty":
        return !present
      default:
        return false
    }
  }
  const items =
    stored === null || stored === undefined ? [] : conditionItems(stored)
  const has = (option: string) => items.includes(option)
  const exact = () =>
    items.every((item) => typeof item === "string" && list.includes(item)) &&
    list.every(has)
  switch (operator) {
    case "in":
      return list.some(has)
    case "notIn":
      return !list.some(has)
    case "contains":
      return list.every(has)
    case "eq":
      return exact()
    case "ne":
      return !exact()
    case "isNotEmpty":
      return items.length > 0
    case "isEmpty":
      return items.length === 0
    default:
      return false
  }
}
