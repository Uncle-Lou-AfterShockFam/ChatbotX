import { contactFilterFields } from "../../partials"
import type { ContactFilterCriteriaInput } from "./types"

/**
 * Runtime shape-check for `Broadcast.contactFilter`, an untyped jsonb column
 * (`unknown`, not `ContactFilterCriteriaInput`) — used by
 * the broadcast resend and the worker's prepare step before a persisted
 * filter reaches the SQL builder.
 *
 * `operator` is checked against the exact `"and" | "or"` union the type
 * declares, not merely for presence: `applyContactFilter` branches only on
 * `=== "or"`, so any other stored value would silently degrade to `AND` and
 * resend to a *different* audience than the one the filter describes.
 *
 * Every condition's `field` is checked against `contactFilterFields`
 * (`@chatbotx.io/database/partials`) — the same enum the SQL builder's
 * `buildConditionWhere` switch is written against. This is NOT optional:
 * `buildConditionWhere`'s `default` case returns `{}` for an unrecognised
 * field, `applyContactFilter` then filters out every empty where, and an
 * all-conditions-unknown filter collapses to `{}` — i.e. *no* filtering at
 * all, silently sending to the full workspace audience instead of the
 * narrower one the stored filter describes. A stored filter that fails this
 * check REJECTS the resend (422, owner decision s206): it no longer falls
 * back to the full eligible audience, since an invalid filter must never
 * widen.
 *
 * Per-field `value`/`timezone` shape (e.g. `timezone` string length) is
 * still unvalidated here — the full per-condition schema lives in
 * `apps/builder`, which this package cannot import — but an unknown/renamed
 * `field` is exactly the case that previously produced a silently-widened
 * audience, so it is the one this function must not let through.
 */
export const isContactFilterShape = (
  value: unknown,
): value is ContactFilterCriteriaInput => {
  if (typeof value !== "object" || value === null) {
    return false
  }
  const { operator, conditions } = value as {
    operator?: unknown
    conditions?: unknown
  }
  if (
    !((operator === "and" || operator === "or") && Array.isArray(conditions))
  ) {
    return false
  }
  return conditions.every((condition) => {
    if (typeof condition !== "object" || condition === null) {
      return false
    }
    const { field } = condition as { field?: unknown }
    return contactFilterFields.safeParse(field).success
  })
}
