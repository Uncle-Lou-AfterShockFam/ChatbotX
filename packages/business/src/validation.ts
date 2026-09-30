import { validationException } from "./errors"

/** A bigint id as the API carries it; anything else never reaches SQL. */
const BIGINT_ID = /^\d{1,19}$/
const BIGINT_MAX = 9_223_372_036_854_775_807n

/** Every named value must be a numeric id string: else a typed 422. */
export function assertIds(fn: string, ids: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(ids)) {
    // Probe s228b: 19 digits can still overflow bigint (a raw 22003).
    if (
      typeof value !== "string" ||
      !BIGINT_ID.test(value) ||
      BigInt(value) > BIGINT_MAX
    ) {
      throw validationException(field, `${fn}: ${field} must be a numeric id`)
    }
  }
}
