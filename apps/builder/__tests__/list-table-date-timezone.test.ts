// @vitest-environment node

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

/**
 * List tables render on the server (UTC process) and hydrate in the viewer's
 * browser, so a `formatDate(...)` without the user's zone prints a different
 * day for anything stamped late in the UTC evening and React throws #418 on
 * the page (s201c: every `/flows` load). Every table / column file must pass
 * `timeZone` (from next-intl's `useTimeZone()`, the same zone the server used).
 */
const ROOT = "src/features"
const TABLE_FILE = /-(table|columns)\.tsx$/
const CALL = /formatDate\(([^()]|\([^()]*\))*\)/g
const HAS_TIME_ZONE = /\btimeZone\b/

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      return files(path)
    }
    return TABLE_FILE.test(path) ? [path] : []
  })
}

describe("list tables format dates in the user's time zone", () => {
  const calls = files(ROOT).flatMap((path) =>
    [...readFileSync(path, "utf8").matchAll(CALL)].map((m) => ({
      path,
      call: m[0],
    })),
  )

  test("the scan finds the known call sites (a broken regex is not a pass)", () => {
    expect(calls.length).toBeGreaterThanOrEqual(7)
  })

  test.each(calls.map((c) => [c.path, c.call]))("%s", (_path, call) => {
    expect(call).toMatch(HAS_TIME_ZONE)
  })
})
