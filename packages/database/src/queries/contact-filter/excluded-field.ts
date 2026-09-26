import type { ContactFilterCriteriaInput } from "./types"

/**
 * Stands in for a condition on a field the caller may not use. It is not a
 * filter field, so it builds no predicate: `applyContactFilter` then fails
 * the filter closed under AND and drops only that branch under OR. Deleting
 * the condition instead would WIDEN the filter, up to everyone (s206).
 */
export const EXCLUDED_FIELD_CONDITION = Object.freeze({
  field: "excludedField",
  operator: "eq",
})

/** Whether pruning replaced any condition of this filter. */
export const hasExcludedFieldCondition = (
  contactFilter: ContactFilterCriteriaInput | null | undefined,
): boolean =>
  Array.isArray(contactFilter?.conditions) &&
  contactFilter.conditions.some(
    (condition) =>
      typeof condition === "object" &&
      condition !== null &&
      (condition as { field?: unknown }).field ===
        EXCLUDED_FIELD_CONDITION.field,
  )
