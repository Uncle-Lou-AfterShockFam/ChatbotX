import {
  isOptionFieldType,
  optionConditionIssue,
} from "@chatbotx.io/utils/custom-field"
import type { AnyColumn, SQL } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { operatorTypes } from "../../partials"

/**
 * The items a stored multiSelect value holds, as a jsonb array. Mirrors
 * `conditionItems` in `@chatbotx.io/utils/custom-field` (the trigger
 * evaluator's JS twin; a real-Postgres property test holds them together):
 * blank -> [], a JSON array -> itself, any other text (legacy, malformed) ->
 * a one-item array. A `CASE`, never an `AND`: Postgres does not promise `AND`
 * evaluation order, and `::jsonb` on non-JSON text throws.
 */
export const optionItemsSql = (column: AnyColumn): SQL =>
  sql`(CASE WHEN ${column} ~ '^\\s*$' THEN '[]'::jsonb WHEN NOT pg_input_is_valid(${column}, 'jsonb') THEN jsonb_build_array(${column}) WHEN jsonb_typeof(${column}::jsonb) = 'array' THEN ${column}::jsonb ELSE jsonb_build_array(${column}) END)`

/** The option list as a jsonb parameter (never string-built SQL). */
const optionListJson = (value: unknown): SQL =>
  sql`${JSON.stringify(value)}::jsonb`

/**
 * Positive predicate for a select / multiSelect condition (s203), or
 * undefined when the condition is not an option-shaped one. The caller then
 * falls back to the text predicates, so a filter saved before s203 (a text
 * operator, or a multiSelect `eq` with a string) keeps its old meaning.
 */
export function buildOptionFieldPredicate(input: {
  column: AnyColumn
  customFieldType: string | undefined
  operator: string
  value: unknown
}): SQL | undefined {
  const { column, customFieldType, operator, value } = input
  if (
    customFieldType === undefined ||
    !isOptionFieldType(customFieldType) ||
    optionConditionIssue(customFieldType, operator, value) !== null
  ) {
    return
  }

  if (customFieldType === "select") {
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
