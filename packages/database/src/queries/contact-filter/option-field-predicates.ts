import {
  isOptionFieldType,
  OPTION_ARRAY_PATTERN_SOURCE,
  OPTION_BLANK_PATTERN_SOURCE,
  type OptionFieldType,
  optionConditionIssue,
} from "@chatbotx.io/utils/custom-field"
import type { AnyColumn, SQL } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { operatorTypes } from "../../partials"

/**
 * The items a stored multiSelect value holds, as a jsonb array. Mirrors
 * `conditionItems` in `@chatbotx.io/utils/custom-field` (the trigger
 * evaluator's JS twin; a real-Postgres property test holds them together):
 * blank -> [], a flat JSON string array -> itself, any other text (legacy,
 * malformed, nested) -> a one-item array. Both sides test the SAME pattern
 * sources (passed as parameters), and `::jsonb` only runs on text the array
 * pattern matched, so no stored value can make the cast (or a JSON parser
 * recursing on deep nesting) throw and abort a contact list. A `CASE`, never
 * an `AND`: Postgres does not promise `AND` evaluation order.
 */
export const optionItemsSql = (column: AnyColumn): SQL =>
  sql`(CASE WHEN ${column} ~ ${OPTION_BLANK_PATTERN_SOURCE} THEN '[]'::jsonb WHEN ${column} ~ ${OPTION_ARRAY_PATTERN_SOURCE} THEN ${column}::jsonb ELSE jsonb_build_array(${column}) END)`

/** The option list as a jsonb parameter (never string-built SQL). */
const optionListJson = (value: unknown): SQL =>
  sql`${JSON.stringify(value)}::jsonb`

/**
 * An option-shaped condition: `valueType` names the option type (what the
 * s203 builder saves) and matches the field's type. A condition saved before
 * s203 carries `valueType: "text"` and keeps its text meaning (the text
 * predicates), so an old broadcast / flow filter behaves exactly as before.
 */
export const optionFieldConditionType = (input: {
  customFieldType?: string
  valueType?: string
}): OptionFieldType | undefined =>
  input.customFieldType !== undefined &&
  isOptionFieldType(input.customFieldType) &&
  input.valueType === input.customFieldType
    ? input.customFieldType
    : undefined

/**
 * True when an option-shaped condition is malformed (an operator outside the
 * table, a list where one option is expected, an empty list...). The caller
 * compiles it to FALSE for the whole condition, never drops it: a dropped
 * condition would silently WIDEN an AND audience (flows and templates reach
 * here through a loose persisted schema, not the builder's closed one).
 */
export const isMalformedOptionCondition = (input: {
  customFieldType?: string
  valueType?: string
  operator: string
  value?: unknown
}): boolean => {
  const type = optionFieldConditionType(input)
  return (
    type !== undefined &&
    optionConditionIssue(type, input.operator, input.value) !== null
  )
}

/**
 * Positive predicate for a valid option-shaped condition (see
 * {@link optionFieldConditionType}), or undefined when the condition is not
 * option-shaped (the caller then uses the text predicates).
 */
export function buildOptionFieldPredicate(input: {
  column: AnyColumn
  customFieldType: string | undefined
  valueType: string | undefined
  operator: string
  value: unknown
}): SQL | undefined {
  const { column, operator, value } = input
  const type = optionFieldConditionType(input)
  if (
    type === undefined ||
    optionConditionIssue(type, operator, value) !== null
  ) {
    return
  }

  if (type === "select") {
    switch (operator) {
      case operatorTypes.enum.eq:
        return sql`${column} = ${value as string}`
      case operatorTypes.enum.in:
        return sql`${column} = ANY(ARRAY(SELECT jsonb_array_elements_text(${optionListJson(value)})))`
      case operatorTypes.enum.isNotEmpty:
        return sql`(${column} IS NOT NULL AND ${column} <> '')`
      default:
        return
    }
  }

  const items = optionItemsSql(column)
  switch (operator) {
    case operatorTypes.enum.in:
      return sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${optionListJson(value)}) AS picked(option) WHERE ${items} @> jsonb_build_array(picked.option))`
    case operatorTypes.enum.contains:
      return sql`${items} @> ${optionListJson(value)}`
    case operatorTypes.enum.eq:
      return sql`(${items} @> ${optionListJson(value)} AND ${items} <@ ${optionListJson(value)})`
    case operatorTypes.enum.isNotEmpty:
      return sql`jsonb_array_length(${items}) > 0`
    default:
      return
  }
}
