// @vitest-environment node

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { describe, expect, test } from "vitest"

/**
 * The builder renders on the server (a UTC process) and hydrates in the
 * viewer's browser, so a `formatDate(...)` without the user's zone prints a
 * different day (or hour) for the same instant and React throws #418 on the
 * page (s201c: every `/flows` load). A server component without the zone is
 * wrong too: it prints UTC to a viewer who is not in UTC. Every call in
 * `src` must pass `timeZone` in its options object (next-intl's
 * `useTimeZone()` / `getTimeZone()`, the same zone on both sides).
 *
 * Checked on the TypeScript AST, not text: an import alias
 * (`formatDate as fd`) is followed, strings and comments cannot desync the
 * scan, and any use the gate cannot verify (passed as a value, `.call`)
 * FAILS rather than being skipped.
 */
const ROOT = "src"
const SOURCE_FILE = /\.(ts|tsx)$/
const NAME = "formatDate"

type Finding = { path: string; line: number; problem: string }
type Scan = { calls: number; findings: Finding[] }

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      return name === "__tests__" ? [] : files(path)
    }
    return SOURCE_FILE.test(path) ? [path] : []
  })
}

/** Local names bound to `formatDate`: imports (aliased or not) and local declarations. */
function boundNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  const visit = (node: ts.Node) => {
    if (ts.isImportSpecifier(node)) {
      if ((node.propertyName ?? node.name).text === NAME) {
        names.add(node.name.text)
      }
    } else if (
      (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === NAME
    ) {
      names.add(NAME)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return names
}

function hasTimeZoneProperty(arg: ts.Expression | undefined): boolean {
  if (!(arg && ts.isObjectLiteralExpression(arg))) {
    return false
  }
  return arg.properties.some(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
      p.name.text === "timeZone",
  )
}

/** Is `id` the name being declared or imported here (not a use)? */
function isBindingSite(id: ts.Identifier): boolean {
  const parent = id.parent
  return (
    ts.isImportSpecifier(parent) ||
    ((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent)) &&
      parent.name === id)
  )
}

function scanSource(path: string, source: string): Scan {
  const sf = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const names = boundNames(sf)
  const findings: Finding[] = []
  let calls = 0
  const report = (node: ts.Node, problem: string) =>
    findings.push({
      path,
      line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      problem,
    })
  const visit = (node: ts.Node) => {
    const isUse =
      ts.isIdentifier(node) &&
      names.has(node.text) &&
      !isBindingSite(node) &&
      // `obj.formatDate` is some other object's member, not this binding.
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    if (isUse) {
      const parent = node.parent
      if (ts.isCallExpression(parent) && parent.expression === node) {
        calls++
        if (!hasTimeZoneProperty(parent.arguments[1])) {
          report(node, "call without timeZone in its options object")
        }
      } else {
        report(node, "used as a value; the gate cannot verify its options")
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { calls, findings }
}

describe("formatDate calls pass the user's time zone", () => {
  const scans = files(ROOT).map((path) =>
    scanSource(path, readFileSync(path, "utf8")),
  )
  const calls = scans.reduce((sum, s) => sum + s.calls, 0)
  const findings = scans.flatMap((s) => s.findings)

  test("the scan finds the known call sites (a broken scanner is not a pass)", () => {
    expect(calls).toBeGreaterThanOrEqual(16)
  })

  test("every formatDate use in src passes timeZone", () => {
    expect(findings).toEqual([])
  })
})

describe("the gate's own scanner (s201c skeptic re-verify)", () => {
  const scan = (source: string) => scanSource("x.tsx", source)
  const importUi = 'import { formatDate } from "@chatbotx.io/ui/lib/format"\n'

  test("passes a call with timeZone, shorthand or assigned", () => {
    expect(
      scan(`${importUi}formatDate(d, { locale, timeZone })`).findings,
    ).toEqual([])
    expect(
      scan(`${importUi}formatDate(d, { timeZone: pick(zone(x)) })`).findings,
    ).toEqual([])
  })

  test("fails a call without options or without timeZone", () => {
    expect(scan(`${importUi}formatDate(d)`).findings).toHaveLength(1)
    expect(scan(`${importUi}formatDate(d, { locale })`).findings).toHaveLength(
      1,
    )
  })

  test("follows an import alias", () => {
    const aliased =
      'import { formatDate as fd } from "@chatbotx.io/ui/lib/format"\nfd(d, { locale })'
    expect(scan(aliased).calls).toBe(1)
    expect(scan(aliased).findings).toHaveLength(1)
  })

  test("a stray paren in a string or comment cannot turn a bad call into a pass", () => {
    const desync = `${importUi}formatDate(d, { hint: ":-(" })\nconst timeZone = 1 // see above)\n`
    expect(scan(desync).findings).toHaveLength(1)
  })

  test("the word timeZone as an options VALUE does not count", () => {
    expect(
      scan(`${importUi}formatDate(d, { locale: timeZone })`).findings,
    ).toHaveLength(1)
  })

  test("a use the gate cannot verify fails instead of being skipped", () => {
    expect(scan(`${importUi}dates.map(formatDate)`).findings).toHaveLength(1)
    expect(
      scan(`${importUi}formatDate.call(null, d, { locale })`).findings,
    ).toHaveLength(1)
  })

  test("a local declaration named formatDate is checked too", () => {
    const local =
      "const formatDate = (v, o) => v\nformatDate(a, { locale })\nformatDate(b, { locale, timeZone })"
    expect(scan(local).calls).toBe(2)
    expect(scan(local).findings).toHaveLength(1)
  })

  test("identifiers that only contain the name are ignored", () => {
    expect(scan("formatDateTime(d)\nmyformatDate(d)").findings).toEqual([])
  })
})
