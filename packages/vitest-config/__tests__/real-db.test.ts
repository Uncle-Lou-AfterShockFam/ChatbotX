import { afterEach, describe, expect, test, vi } from "vitest"
import { realDatabaseUrl, requireRealDatabaseUrl } from "../src/real-db.ts"

const REQUIRED_MESSAGE = /test:db needs DATABASE_URL/
const REAL = "postgres://u:p@127.0.0.1:55432/chatbotx"
const SENTINEL =
  "postgresql://test:test@127.0.0.1:1/chatbotx_test?schema=public"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("realDatabaseUrl", () => {
  test("returns a real URL unchanged", () => {
    vi.stubEnv("DATABASE_URL", REAL)
    expect(realDatabaseUrl()).toBe(REAL)
  })

  test.each([
    ["the setup-env sentinel", SENTINEL],
    ["an empty string", ""],
    ["an unparsable URL", "not a url"],
  ])("is null for %s", (_label, value) => {
    vi.stubEnv("DATABASE_URL", value)
    expect(realDatabaseUrl()).toBeNull()
  })

  test("is null when unset", () => {
    vi.stubEnv("DATABASE_URL", undefined)
    expect(realDatabaseUrl()).toBeNull()
  })
})

describe("requireRealDatabaseUrl", () => {
  test("returns null (suite skips) without REQUIRE_REAL_DB", () => {
    vi.stubEnv("DATABASE_URL", SENTINEL)
    vi.stubEnv("REQUIRE_REAL_DB", undefined)
    expect(requireRealDatabaseUrl()).toBeNull()
  })

  test("throws under REQUIRE_REAL_DB=1 when no real database is configured", () => {
    vi.stubEnv("DATABASE_URL", SENTINEL)
    vi.stubEnv("REQUIRE_REAL_DB", "1")
    expect(() => requireRealDatabaseUrl()).toThrow(REQUIRED_MESSAGE)
  })

  test("returns the URL under REQUIRE_REAL_DB=1 when one is configured", () => {
    vi.stubEnv("DATABASE_URL", REAL)
    vi.stubEnv("REQUIRE_REAL_DB", "1")
    expect(requireRealDatabaseUrl()).toBe(REAL)
  })
})
