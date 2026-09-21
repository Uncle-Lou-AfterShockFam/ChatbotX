/**
 * Optional narrowing of the permission set a Meta OAuth dialog requests.
 *
 * The shipped defaults (`MESSENGER_SCOPES`, `INSTAGRAM_SCOPES`) are the classic
 * Facebook Login set. An app created as "Facebook Login for Business" (the only
 * kind Meta lets a new business app be) answers "Invalid Scopes" to any
 * permission that is not attached to one of its use cases — `email`,
 * `page_events`, `pages_manage_posts`, `instagram_manage_events`, ... — and the
 * whole connect fails. A self-hosted install lists exactly what its app offers:
 *
 *   MESSENGER_OAUTH_SCOPES=pages_messaging,pages_show_list,pages_manage_metadata,...
 *   INSTAGRAM_FACEBOOK_OAUTH_SCOPES=instagram_basic,instagram_manage_messages,...
 *
 * Unset or blank = the defaults. A malformed entry throws (fail closed): a
 * silently dropped scope would surface much later as a missing permission.
 * `env.ts` runs the same parser as a schema refinement, so a malformed value
 * fails the boot, not the first connect click. Callers pass the validated
 * `env.MESSENGER_OAUTH_SCOPES` / `env.INSTAGRAM_FACEBOOK_OAUTH_SCOPES`.
 */
const SCOPE_PATTERN = /^[a-z][a-z0-9_]*$/

export const MESSENGER_OAUTH_SCOPES_ENV = "MESSENGER_OAUTH_SCOPES"
export const INSTAGRAM_FACEBOOK_OAUTH_SCOPES_ENV =
  "INSTAGRAM_FACEBOOK_OAUTH_SCOPES"

export function resolveMetaOAuthScopes(
  raw: string | undefined | null,
  defaults: readonly string[],
  envName: string,
): readonly string[] {
  if (!Array.isArray(defaults) || defaults.length === 0) {
    throw new TypeError(
      "resolveMetaOAuthScopes: defaults must be a non-empty array",
    )
  }
  if (raw === undefined || raw === null) {
    return defaults
  }
  if (typeof raw !== "string") {
    throw new TypeError(`${envName} must be a comma-separated string`)
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return defaults
  }
  const scopes: string[] = []
  for (const part of trimmed.split(",")) {
    const scope = part.trim()
    if (scope.length === 0) {
      continue
    }
    if (!SCOPE_PATTERN.test(scope)) {
      throw new Error(`${envName}: invalid scope "${scope}"`)
    }
    if (!scopes.includes(scope)) {
      scopes.push(scope)
    }
  }
  if (scopes.length === 0) {
    throw new Error(`${envName}: no scopes after parsing "${raw}"`)
  }
  return scopes
}
