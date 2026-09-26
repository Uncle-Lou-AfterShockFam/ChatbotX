// @vitest-environment node

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { beforeAll, describe, expect, test } from "vitest"

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

/**
 * s202c: the same UTC-server / viewer-browser split breaks the platform
 * formatters. A Date's `toLocaleString` / `toLocaleDateString` /
 * `toLocaleTimeString` and every `Intl.DateTimeFormat` (constructed or called,
 * including the `Intl.DateTimeFormat().resolvedOptions().timeZone` zone probe,
 * which answers "UTC" in a server component) must pass `timeZone` in its
 * options, or sit directly under a `// zone: viewer (<reason>)` line: an
 * explicit, reviewed choice of the viewer's own zone (client code only).
 *
 * Receivers are resolved with the type checker: `n.toLocaleString(locale)` on
 * a number carries no zone and is not a date. A receiver typed any/unknown
 * FAILS, since the gate cannot tell which one it is.
 */
const LOCALE_METHODS = new Set([
  "toLocaleString",
  "toLocaleDateString",
  "toLocaleTimeString",
])
const VIEWER_ZONE = /^\/\/ zone: viewer\b(.*)$/
const VIEWER_REASON = /^ \(\S.*\)$/

type Dateness = "date" | "other" | "unknown"

const hasAnyFlag = (t: ts.Type, flags: ts.TypeFlags[]) =>
  // biome-ignore lint/suspicious/noBitwiseOperators: TypeFlags is a bit set; the API has no other test
  flags.some((flag) => (t.flags & flag) !== 0)

function dateness(checker: ts.TypeChecker, type: ts.Type): Dateness {
  let result: Dateness = "other"
  for (const part of type.isUnion() ? type.types : [type]) {
    const t = checker.getBaseConstraintOfType(part) ?? part
    if (hasAnyFlag(t, [ts.TypeFlags.Null, ts.TypeFlags.Undefined])) {
      continue
    }
    if (hasAnyFlag(t, [ts.TypeFlags.Any, ts.TypeFlags.Unknown])) {
      result = result === "date" ? "date" : "unknown"
    } else if (t.getSymbol()?.getName() === "Date") {
      result = "date"
    }
  }
  return result
}

function scanZones(program: ts.Program, paths: ReadonlySet<string>): Scan {
  const checker = program.getTypeChecker()
  const findings: Finding[] = []
  let calls = 0
  for (const sf of program.getSourceFiles()) {
    if (!paths.has(sf.fileName)) {
      continue
    }
    const lines = sf.text.split("\n")
    const lineOf = (node: ts.Node) =>
      sf.getLineAndCharacterOfPosition(node.getStart()).line
    const report = (node: ts.Node, problem: string) =>
      findings.push({ path: sf.fileName, line: lineOf(node) + 1, problem })
    /** Checks one formatting call: zone passed, or a reasoned viewer comment. */
    const check = (node: ts.Node, call: ts.CallLikeExpression | undefined) => {
      const options =
        call && (ts.isCallExpression(call) || ts.isNewExpression(call))
          ? call.arguments?.[1]
          : undefined
      if (hasTimeZoneProperty(options)) {
        return
      }
      const above = VIEWER_ZONE.exec((lines[lineOf(node) - 1] ?? "").trim())
      if (!above) {
        report(
          node,
          "no timeZone in its options and no `// zone: viewer (<reason>)`",
        )
      } else if (!VIEWER_REASON.test(above[1] ?? "")) {
        report(node, "`// zone: viewer` without a (reason)")
      }
    }
    const isIntl = (expr: ts.Expression) =>
      checker.getSymbolAtLocation(expr)?.getName() === "Intl"
    /** One member access: `recv.name` / `recv["name"]` / `{ name } = recv`. */
    const member = (
      node: ts.Node,
      receiver: ts.Expression,
      name: string,
      called: ts.CallExpression | ts.NewExpression | undefined,
    ) => {
      if (name === "DateTimeFormat" && isIntl(receiver)) {
        calls++
        if (called) {
          check(node, called)
        } else if (
          !(
            (ts.isPropertyAccessExpression(node.parent) ||
              ts.isElementAccessExpression(node.parent)) &&
            node.parent.expression === node &&
            ts.isPropertyAccessExpression(node.parent) &&
            node.parent.name.text === "supportedLocalesOf"
          )
        ) {
          report(
            node,
            "Intl.DateTimeFormat used as a value; the gate cannot verify its options",
          )
        }
      } else if (LOCALE_METHODS.has(name)) {
        const kind = dateness(checker, checker.getTypeAtLocation(receiver))
        if (kind === "unknown") {
          report(
            node,
            `${name} on an untyped receiver; the gate cannot tell a date from a number`,
          )
        } else if (kind === "date") {
          calls++
          if (called && ts.isCallExpression(called)) {
            check(node, called)
          } else {
            report(
              node,
              `Date#${name} used as a value; the gate cannot verify its options`,
            )
          }
        }
      }
    }
    const visit = (node: ts.Node) => {
      const access =
        ts.isPropertyAccessExpression(node) ||
        (ts.isElementAccessExpression(node) &&
          ts.isStringLiteralLike(node.argumentExpression))
      if (access) {
        const parent = node.parent
        const called =
          (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
          parent.expression === node
            ? parent
            : undefined
        const name = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : (node.argumentExpression as ts.StringLiteralLike).text
        member(node, node.expression, name, called)
      } else if (
        ts.isBindingElement(node) &&
        ts.isObjectBindingPattern(node.parent) &&
        ts.isVariableDeclaration(node.parent.parent) &&
        node.parent.parent.initializer
      ) {
        const key = node.propertyName ?? node.name
        if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) {
          member(node, node.parent.parent.initializer, key.text, undefined)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return { calls, findings }
}

describe("Date#toLocale*String and Intl.DateTimeFormat pass a zone (s202c)", () => {
  let scan: Scan = { calls: 0, findings: [] }

  beforeAll(() => {
    const config = ts.getParsedCommandLineOfConfigFile(
      "tsconfig.json",
      {},
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
    )
    if (!config) {
      throw new Error("tsconfig.json did not parse")
    }
    const roots = new Set(files(ROOT).map((path) => join(process.cwd(), path)))
    const program = ts.createProgram([...roots], {
      ...config.options,
      incremental: false,
      noEmit: true,
    })
    scan = scanZones(program, roots)
  }, 180_000)

  test("the scan finds the known call sites (a broken scanner is not a pass)", () => {
    expect(scan.calls).toBeGreaterThanOrEqual(20)
  })

  test("every date formatter in src passes timeZone or names the viewer's zone", () => {
    expect(scan.findings).toEqual([])
  })
})

describe("the zone scanner itself (s202c)", () => {
  const FILE = "/virtual/x.tsx"
  // Deliberately NOT tsconfig.json: these fixtures only need the ES + DOM
  // globals (Date, Intl), and a minimal program keeps each scan fast.
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    jsx: ts.JsxEmit.Preserve,
    strict: true,
    noEmit: true,
    types: [],
  }
  const host = ts.createCompilerHost(options)
  const libCache = new Map<string, ts.SourceFile | undefined>()
  const baseGet = host.getSourceFile.bind(host)
  let source = ""
  host.getSourceFile = (name, lang, ...rest) => {
    if (name === FILE) {
      return ts.createSourceFile(name, source, lang, true, ts.ScriptKind.TSX)
    }
    if (!libCache.has(name)) {
      libCache.set(name, baseGet(name, lang, ...rest))
    }
    return libCache.get(name)
  }
  const baseExists = host.fileExists.bind(host)
  host.fileExists = (name) => name === FILE || baseExists(name)
  const scan = (text: string) => {
    source = text
    return scanZones(ts.createProgram([FILE], options, host), new Set([FILE]))
  }

  test("a Date formatted without a zone fails, with a zone passes", () => {
    expect(scan("new Date().toLocaleString()").findings).toHaveLength(1)
    expect(
      scan('declare const d: Date | null\nd?.toLocaleDateString("en")')
        .findings,
    ).toHaveLength(1)
    expect(
      scan(
        "declare const timeZone: string\nnew Date().toLocaleTimeString(undefined, { timeZone })",
      ).findings,
    ).toEqual([])
  })

  test("a number's toLocaleString is not a date", () => {
    const r = scan('declare const n: number\nn.toLocaleString("en")')
    expect(r.calls).toBe(0)
    expect(r.findings).toEqual([])
  })

  test("an untyped receiver fails closed", () => {
    expect(
      scan("declare const v: any\nv.toLocaleString()").findings,
    ).toHaveLength(1)
  })

  test("a Date method passed as a value fails", () => {
    expect(
      scan("const f = new Date().toLocaleString\nf()").findings,
    ).toHaveLength(1)
  })

  test("a generic constrained to Date is a date", () => {
    expect(
      scan("function f<T extends Date>(d: T) { return d.toLocaleString() }")
        .findings,
    ).toHaveLength(1)
  })

  test("Intl.DateTimeFormat constructed or called needs a zone, the zone probe included", () => {
    expect(
      scan('new Intl.DateTimeFormat("en", { month: "short" })').findings,
    ).toHaveLength(1)
    expect(
      scan("Intl.DateTimeFormat().resolvedOptions().timeZone").findings,
    ).toHaveLength(1)
    expect(
      scan('new Intl.DateTimeFormat("en", { timeZone: "UTC" })').findings,
    ).toEqual([])
  })

  test("a reasoned viewer comment on the line above allows the viewer's zone", () => {
    expect(
      scan(
        "// zone: viewer (browser-local calendar labels)\nnew Intl.DateTimeFormat()",
      ).findings,
    ).toEqual([])
    expect(
      scan("// zone: viewer\nnew Intl.DateTimeFormat()").findings,
    ).toHaveLength(1)
    expect(
      scan("// zone: viewer ()\nnew Intl.DateTimeFormat()").findings,
    ).toHaveLength(1)
    expect(
      scan("// zone: viewer (reason)\n\nnew Intl.DateTimeFormat()").findings,
    ).toHaveLength(1)
  })

  test("Intl.DateTimeFormat as a value fails; supportedLocalesOf is fine", () => {
    expect(
      scan("const F = Intl.DateTimeFormat\nnew F()").findings,
    ).toHaveLength(1)
    expect(
      scan('Intl.DateTimeFormat.supportedLocalesOf(["en"])').findings,
    ).toEqual([])
  })

  test("bracket access, destructuring and globalThis.Intl do not escape", () => {
    expect(scan('new Date()["toLocaleString"]()').findings).toHaveLength(1)
    expect(
      scan("const { toLocaleDateString } = new Date()").findings,
    ).toHaveLength(1)
    expect(
      scan('new globalThis.Intl.DateTimeFormat("en")').findings,
    ).toHaveLength(1)
    expect(scan('new Intl["DateTimeFormat"]("en")').findings).toHaveLength(1)
    expect(scan("const { DateTimeFormat } = Intl").findings).toHaveLength(1)
  })

  test("optional call on a Date still needs a zone", () => {
    expect(
      scan("declare const d: Date | undefined\nd?.toLocaleString?.()").findings,
    ).toHaveLength(1)
  })

  test("the word timeZone as a value does not count", () => {
    expect(
      scan(
        "declare const timeZone: string\nnew Date().toLocaleString(timeZone)",
      ).findings,
    ).toHaveLength(1)
  })
})

/**
 * s203c: date-fns formats in the PROCESS zone and takes no `timeZone` option,
 * so the same split applies (`/error-logs` threw #418 on every load; 22 table
 * and dialog renders shared the bug). A render uses `formatWithFallback(date,
 * timeZone, pattern)` from `@chatbotx.io/utils/datetime`. Otherwise the call
 * sits directly under a reasoned `// zone: viewer (<reason>)` (client code,
 * the viewer's zone on purpose) or `// zone: wall-clock (<reason>)` (fields
 * built in the local zone and read back in it, e.g. a calendar day key).
 *
 * Syntactic, per file, like the formatDate scan: a formatter can only reach a
 * file through that file's own `date-fns` import, because re-exporting one
 * from `src` fails here too. A shadowing local of the same name fails closed.
 */
const DATE_FNS_MODULE = /^date-fns(\/|$)/
const DATE_FNS_FORMATTERS = new Set([
  "format",
  "formatDate",
  "lightFormat",
  "formatRelative",
])
const LOCAL_ZONE = /^\/\/ zone: (viewer|wall-clock)\b(.*)$/

/** Local names bound to date-fns formatters, and date-fns namespaces. */
function dateFnsBindings(
  sf: ts.SourceFile,
  report: (node: ts.Node, problem: string) => void,
) {
  const names = new Set<string>()
  const namespaces = new Set<string>()
  for (const statement of sf.statements) {
    const specifier =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined
    if (
      !(
        specifier &&
        ts.isStringLiteral(specifier) &&
        DATE_FNS_MODULE.test(specifier.text)
      )
    ) {
      continue
    }
    if (ts.isExportDeclaration(statement)) {
      report(statement, "re-exports date-fns; the gate only follows imports")
      continue
    }
    const clause = (statement as ts.ImportDeclaration).importClause
    if (clause?.name) {
      // `import format from "date-fns/format"`
      names.add(clause.name.text)
    }
    const bindings = clause?.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text)
    } else if (bindings) {
      for (const spec of bindings.elements) {
        if (DATE_FNS_FORMATTERS.has((spec.propertyName ?? spec.name).text)) {
          names.add(spec.name.text)
        }
      }
    }
  }
  return { names, namespaces }
}

function scanDateFns(path: string, source: string): Scan {
  const sf = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const lines = source.split("\n")
  const findings: Finding[] = []
  let calls = 0
  const lineOf = (node: ts.Node) =>
    sf.getLineAndCharacterOfPosition(node.getStart()).line
  const report = (node: ts.Node, problem: string) =>
    findings.push({ path, line: lineOf(node) + 1, problem })
  if (!source.includes("date-fns")) {
    return { calls, findings }
  }
  const { names, namespaces } = dateFnsBindings(sf, report)

  /** One reference to a formatter: a direct call under a reasoned comment. */
  const check = (callee: ts.Expression) => {
    calls++
    const call = callee.parent
    if (!(ts.isCallExpression(call) && call.expression === callee)) {
      report(callee, "date-fns formatter used as a value; cannot verify it")
      return
    }
    const above = LOCAL_ZONE.exec((lines[lineOf(call) - 1] ?? "").trim())
    if (!above) {
      report(
        callee,
        "date-fns formats in the process zone: use formatWithFallback, or `// zone: viewer|wall-clock (<reason>)`",
      )
    } else if (!VIEWER_REASON.test(above[2] ?? "")) {
      report(callee, `\`// zone: ${above[1]}\` without a (reason)`)
    }
  }
  const visit = (node: ts.Node) => {
    const parent = node.parent
    const [first] = ts.isCallExpression(node) ? node.arguments : []
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require")) &&
      first &&
      ts.isStringLiteralLike(first) &&
      DATE_FNS_MODULE.test(first.text)
    ) {
      report(node, "loads date-fns dynamically; the gate only follows imports")
    } else if (
      ts.isExportSpecifier(node) &&
      names.has((node.propertyName ?? node.name).text)
    ) {
      report(
        node,
        "re-exports a date-fns formatter; the gate only follows imports",
      )
    } else if (
      ts.isIdentifier(node) &&
      names.has(node.text) &&
      !ts.isImportClause(parent) &&
      !ts.isImportSpecifier(parent) &&
      !ts.isExportSpecifier(parent) &&
      !(ts.isPropertyAccessExpression(parent) && parent.name === node)
    ) {
      check(node)
    } else if (ts.isIdentifier(node) && namespaces.has(node.text)) {
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        if (DATE_FNS_FORMATTERS.has(parent.name.text)) {
          check(parent)
        }
      } else if (!ts.isNamespaceImport(parent)) {
        // `const { format } = dfns`, `dfns["format"]`, the namespace passed on.
        report(node, "date-fns namespace used other than `ns.fn(...)`")
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { calls, findings }
}

describe("date-fns formatters name a zone (s203c)", () => {
  const scans = files(ROOT).map((path) =>
    scanDateFns(path, readFileSync(path, "utf8")),
  )

  test("the scan finds the known call sites (a broken scanner is not a pass)", () => {
    expect(scans.reduce((sum, s) => sum + s.calls, 0)).toBeGreaterThanOrEqual(
      10,
    )
  })

  test("every date-fns formatter in src is a reasoned local-zone call", () => {
    expect(scans.flatMap((s) => s.findings)).toEqual([])
  })
})

describe("the date-fns scanner itself (s203c)", () => {
  const scan = (source: string) => scanDateFns("x.tsx", source)
  const named = 'import { format } from "date-fns"\n'

  test("a call needs a reasoned viewer or wall-clock comment directly above", () => {
    expect(scan(`${named}format(d, "yyyy")`).findings).toHaveLength(1)
    expect(
      scan(`${named}// zone: wall-clock (day key)\nformat(d, "yyyy")`).findings,
    ).toEqual([])
    expect(
      scan(`${named}// zone: viewer (client-only label)\nformat(d, "y")`)
        .findings,
    ).toEqual([])
    expect(
      scan(`${named}// zone: wall-clock\nformat(d, "yyyy")`).findings,
    ).toHaveLength(1)
    expect(
      scan(`${named}// zone: wall-clock (day key)\n\nformat(d, "yyyy")`)
        .findings,
    ).toHaveLength(1)
  })

  test("aliases, formatDate, lightFormat, default and namespace imports count", () => {
    for (const source of [
      'import { format as f } from "date-fns"\nf(d, "y")',
      'import { formatDate } from "date-fns"\nformatDate(d, "y")',
      'import { lightFormat } from "date-fns"\nlightFormat(d, "y")',
      'import format from "date-fns/format"\nformat(d, "y")',
      'import * as dfns from "date-fns"\ndfns.format(d, "y")',
    ]) {
      expect(scan(source).findings).toHaveLength(1)
    }
  })

  test("a formatter or namespace used as a value fails, comment or not", () => {
    for (const source of [
      `${named}// zone: wall-clock (day key)\nconst fn = format`,
      'import * as dfns from "date-fns"\nconst { format } = dfns',
      'import * as dfns from "date-fns"\ndfns["format"](d, "y")',
    ]) {
      expect(scan(source).findings).toHaveLength(1)
    }
  })

  test("a dynamic import or require of date-fns fails", () => {
    for (const source of [
      'const dfns = await import("date-fns")\ndfns.format(d, "y")',
      'const { format } = require("date-fns/format")',
    ]) {
      expect(scan(source).findings).toHaveLength(1)
    }
  })

  test("re-exporting date-fns or one of its formatters fails", () => {
    expect(
      scan('export { format as fmt } from "date-fns"').findings,
    ).toHaveLength(1)
    expect(scan(`${named}export { format }`).findings).toHaveLength(1)
  })

  test("non-formatters and files without a date-fns import are ignored", () => {
    for (const source of [
      'import { addDays } from "date-fns"\naddDays(d, 1)',
      'import * as dfns from "date-fns"\ndfns.addDays(d, 1)',
      "function format(d, p) { return p }\nformat(d, 'y')",
      'import { format } from "./my-format"\nformat(d, "y")',
    ]) {
      expect(scan(source).findings).toEqual([])
    }
  })
})

/**
 * s205c: `formatDistanceToNow*` reads the clock DURING render, so the server
 * render and the hydrating client can print different words ("1 minute ago"
 * vs "2 minutes ago") and React throws #418 (`/contacts`, 1 load in 2). Render
 * `<RelativeTime>` or read `useRenderNow()`, whose first value is the
 * request's `now` on both sides. No comment escape: there is no zone reason
 * that makes a render-time clock read hydration-safe.
 */
const CLOCK_FORMATTER_MODULE = /^date-fns\/formatDistanceToNow(Strict)?$/
const CLOCK_FORMATTERS = new Set([
  "formatDistanceToNow",
  "formatDistanceToNowStrict",
])

function scanClockFormatters(path: string, source: string): Scan {
  const findings: Finding[] = []
  if (!source.includes("date-fns")) {
    return { calls: 0, findings }
  }
  const sf = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  let calls = 0
  const report = (node: ts.Node) => {
    calls++
    findings.push({
      path,
      line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      problem:
        "formatDistanceToNow* reads the clock at render: use <RelativeTime> or useRenderNow()",
    })
  }
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportSpecifier(node) &&
        CLOCK_FORMATTERS.has((node.propertyName ?? node.name).text)) ||
      (ts.isPropertyAccessExpression(node) &&
        CLOCK_FORMATTERS.has(node.name.text)) ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        CLOCK_FORMATTERS.has(node.argumentExpression.text)) ||
      (ts.isBindingElement(node) &&
        ts.isIdentifier(node.propertyName ?? node.name) &&
        CLOCK_FORMATTERS.has(
          ((node.propertyName ?? node.name) as ts.Identifier).text,
        )) ||
      (ts.isStringLiteralLike(node) && CLOCK_FORMATTER_MODULE.test(node.text))
    ) {
      report(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { calls, findings }
}

describe("no render-time clock reads through date-fns (s205c)", () => {
  test("no formatDistanceToNow* in src", () => {
    expect(
      files(ROOT).flatMap(
        (path) =>
          scanClockFormatters(path, readFileSync(path, "utf8")).findings,
      ),
    ).toEqual([])
  })
})

describe("the clock-formatter scanner itself (s205c)", () => {
  const scan = (source: string) => scanClockFormatters("x.tsx", source)

  test("named, aliased, namespace and subpath uses fail", () => {
    for (const source of [
      'import { formatDistanceToNow } from "date-fns"',
      'import { formatDistanceToNowStrict as rel } from "date-fns"',
      'import * as dfns from "date-fns"\ndfns.formatDistanceToNow(d)',
      'import * as dfns from "date-fns"\ndfns["formatDistanceToNowStrict"](d)',
      'import rel from "date-fns/formatDistanceToNow"',
      'const { formatDistanceToNowStrict } = await import("date-fns")',
      'const { formatDistanceToNow: rel } = require("date-fns")',
    ]) {
      expect(scan(source).findings.length).toBeGreaterThan(0)
    }
  })

  test("clock-free formatters and files without date-fns pass", () => {
    for (const source of [
      'import { formatDistance, formatDistanceStrict } from "date-fns"',
      "const formatDistanceToNow = 1",
    ]) {
      expect(scan(source).findings).toEqual([])
    }
  })
})
