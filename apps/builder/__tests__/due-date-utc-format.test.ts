// @vitest-environment node

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

/**
 * A due date is stored as the UTC midnight of the chosen day, so every
 * `format.dateTime(<x>.dueAt, ...)` must pass `timeZone: "UTC"`; in the
 * viewer's zone west of UTC it renders the day BEFORE (s192 drawer, s197
 * Contact / Company 360 task list).
 */
const ROOT = "src/features"
const CALL = /format\.dateTime\(\s*[\w.?]*dueAt\b[^)]*\)/g
const UTC_ZONE = /timeZone:\s*"UTC"/

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      return files(path)
    }
    return path.endsWith(".tsx") || path.endsWith(".ts") ? [path] : []
  })
}

describe("due dates are formatted in UTC", () => {
  const calls = files(ROOT).flatMap((path) =>
    [...readFileSync(path, "utf8").matchAll(CALL)].map((m) => ({
      path,
      call: m[0],
    })),
  )

  test("the scan finds the known call sites (a broken regex is not a pass)", () => {
    expect(calls.length).toBeGreaterThanOrEqual(3)
  })

  test.each(calls.map((c) => [c.path, c.call]))("%s", (_path, call) => {
    expect(call).toMatch(UTC_ZONE)
  })
})
