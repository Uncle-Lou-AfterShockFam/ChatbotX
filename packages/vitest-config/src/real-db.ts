/**
 * Gate for the `__tests__/integration` suites that need a real Postgres.
 *
 * `setup-env` points `DATABASE_URL` at a non-routable `127.0.0.1:1` sentinel,
 * so a suite can tell "no database configured" from "a real one is here" and
 * skip itself in the plain `test` run.
 */

/** The `setup-env` sentinel: a real database never listens on port 1. */
export const NON_ROUTABLE_PORT = "1"

/** The configured database URL, or null when it is unset, unparsable or the sentinel. */
export function realDatabaseUrl(): string | null {
  const url = process.env.DATABASE_URL
  if (!url) {
    return null
  }
  try {
    return new URL(url).port === NON_ROUTABLE_PORT ? null : url
  } catch {
    // An unparsable URL cannot be a reachable database: treat it as absent.
    return null
  }
}

/**
 * `test:db` sets `REQUIRE_REAL_DB=1`: there a skip would be a silent green
 * with nothing run, so a missing database is an error instead.
 */
export function requireRealDatabaseUrl(): string | null {
  const url = realDatabaseUrl()
  if (process.env.REQUIRE_REAL_DB === "1" && !url) {
    throw new Error(
      "test:db needs DATABASE_URL pointing at a migrated Postgres (it is unset or the setup-env sentinel)",
    )
  }
  return url
}
