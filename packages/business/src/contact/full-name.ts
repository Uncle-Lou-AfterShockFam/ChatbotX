const NAME_PARTS_RE = /\s+/

/**
 * "Ada  King Lovelace" -> first "Ada", last "King Lovelace": the `full_name`
 * rule of the contact service, shared by the form submit pipeline (s219).
 */
export function splitFullName(value: string): {
  firstName: string | null
  lastName: string | null
} {
  const [firstName, ...rest] = value.trim().split(NAME_PARTS_RE)
  return {
    firstName: firstName || null,
    lastName: rest.length > 0 ? rest.join(" ") : null,
  }
}
