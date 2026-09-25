// @vitest-environment node

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

/**
 * The builder renders on the server (a UTC process) and hydrates in the
 * viewer's browser, so a `formatDate(...)` without the user's zone prints a
 * different day (or hour) for the same instant and React throws #418 on the
 * page (s201c: every `/flows` load). A server component without the zone is
 * wrong too: it prints UTC to a viewer who is not in UTC. Every call in
 * `src` must pass `timeZone` (next-intl's `useTimeZone()` / `getTimeZone()`,
 * the same zone on both sides).
 */
const ROOT = "src"
const SOURCE_FILE = /\.(ts|tsx)$/
const CALL_START = /\bformatDate\(/g
const HAS_TIME_ZONE = /\btimeZone\b/
/** A call longer than this is a scanner bug, not a real call. */
const MAX_CALL_LENGTH = 2000

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      return name === "__tests__" ? [] : files(path)
    }
    return SOURCE_FILE.test(path) ? [path] : []
  })
}

/**
 * The full text of the call opening at `start` (index of the `(`), matched
 * by paren depth rather than a regex, so any nesting depth or line break is
 * covered. Throws on an unclosed call instead of silently skipping it.
 */
function callText(source: string, start: number): string {
  let depth = 0
  for (let i = start; i < source.length && i - start < MAX_CALL_LENGTH; i++) {
    const ch = source[i]
    if (ch === "(") {
      depth++
    } else if (ch === ")") {
      depth--
      if (depth === 0) {
        return source.slice(start, i + 1)
      }
    }
  }
  throw new Error(`unclosed formatDate( call at offset ${start}`)
}

describe("formatDate calls pass the user's time zone", () => {
  const calls = files(ROOT).flatMap((path) => {
    const source = readFileSync(path, "utf8")
    return [...source.matchAll(CALL_START)].map((m) => ({
      path,
      call: callText(source, (m.index ?? 0) + m[0].length - 1),
    }))
  })

  test("the scan finds the known call sites (a broken scanner is not a pass)", () => {
    expect(calls.length).toBeGreaterThanOrEqual(16)
  })

  test("the scanner sees through nesting and line breaks (s201c skeptic)", () => {
    const nested =
      "x formatDate(row.at, {\n  locale,\n  timeZone: pick(zone(getDefault())),\n}) y"
    const start = nested.indexOf("(")
    expect(callText(nested, start)).toMatch(HAS_TIME_ZONE)
    expect(callText(nested, start).endsWith("})")).toBe(true)
    // The old regex returned NO match for this shape: a silent false pass.
    const hidden = "formatDate(row.at, { locale: pick(zone(a)) })"
    expect(callText(hidden, hidden.indexOf("("))).not.toMatch(HAS_TIME_ZONE)
    expect(() => callText("formatDate(a, {", 10)).toThrow("unclosed")
  })

  test.each(calls.map((c) => [c.path, c.call]))("%s", (_path, call) => {
    expect(call).toMatch(HAS_TIME_ZONE)
  })
})
