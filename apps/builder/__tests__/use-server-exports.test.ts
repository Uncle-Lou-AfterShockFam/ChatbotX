// @vitest-environment node

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"
import { describe, expect, test } from "vitest"

const SRC_ROOT = join(import.meta.dirname, "..", "src")
const TS_LIKE_EXTENSION_PATTERN = /\.(ts|tsx)$/

// s232a: every value export of a "use server" file is a Server Action that
// anyone holding its id can POST to, with arguments of their choosing. A
// plain helper exported next to its safe-action wrapper skips the wrapper's
// session + workspace check and its zod parse: `updateIntegrationOpenAI`
// updated any workspace's row and returned it with the API key, and
// `updateMessenger` / `updateMagicLink` wrote unparsed columns. Helpers live
// in `import "server-only"` modules (or stay unexported); a "use server" file
// exports only values built from a safe-action client (lib/safe-action.ts)
// or the integration disconnect factory built on one.
const SAFE_ACTION_ROOT_PATTERN =
  /ActionClient(?:AllowExpired|AllowScheduledDeletion)?$|^actionClient$/
const SAFE_ACTION_FACTORIES = new Set(["createDisconnectAction"])

// Plain Server Actions that are called from the browser on purpose. Each
// touches only the caller's own cookie and validates its input itself.
const ALLOWED_PLAIN_EXPORTS: Record<string, string[]> = {
  "lib/locale.ts": ["getUserLocale", "setUserLocale"],
  "lib/timezone.action.ts": ["setUserTimezone"],
}

function collectSourceFiles(dir: string, results: string[] = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") {
      continue
    }
    const fullPath = join(dir, entry)
    if (statSync(fullPath).isDirectory()) {
      collectSourceFiles(fullPath, results)
    } else if (TS_LIKE_EXTENSION_PATTERN.test(entry)) {
      results.push(fullPath)
    }
  }
  return results
}

function parse(fileName: string, source: string) {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function hasUseServerDirective(sourceFile: ts.SourceFile) {
  const first = sourceFile.statements[0]
  return (
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === "use server"
  )
}

/** The identifier a call/property chain starts from: `a.b().c()` -> `a`. */
function chainRoot(expression: ts.Expression | undefined): string | null {
  let current = expression
  while (current) {
    if (
      ts.isCallExpression(current) ||
      ts.isPropertyAccessExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression
    } else {
      break
    }
  }
  return current && ts.isIdentifier(current) ? current.text : null
}

function isSafeActionValue(initializer: ts.Expression | undefined) {
  const root = chainRoot(initializer)
  return (
    root !== null &&
    (SAFE_ACTION_ROOT_PATTERN.test(root) || SAFE_ACTION_FACTORIES.has(root))
  )
}

const isExported = (statement: ts.Statement) =>
  ts.canHaveModifiers(statement) &&
  (ts.getModifiers(statement) ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  )

/** Names of value exports not built from a safe-action client. */
function plainServerActionExports(fileName: string, source: string) {
  const sourceFile = parse(fileName, source)
  if (!hasUseServerDirective(sourceFile)) {
    return []
  }

  const names: string[] = []
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.isTypeOnly) {
        names.push(`export { ... } ${statement.getText(sourceFile)}`)
      }
    } else if (ts.isExportAssignment(statement)) {
      names.push("export default")
    } else if (ts.isFunctionDeclaration(statement) && isExported(statement)) {
      names.push(statement.name?.text ?? "export default function")
    } else if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!isSafeActionValue(declaration.initializer)) {
          names.push(declaration.name.getText(sourceFile))
        }
      }
    }
  }
  return names
}

describe('"use server" files export only safe-action values', () => {
  test("the scanner flags plain exports and passes wrapped ones", () => {
    const source = `"use server"
import { workspaceActionClient } from "@/lib/safe-action"
export type Row = { id: string }
export const updateThingAction = workspaceActionClient
  .inputSchema(schema)
  .action(async () => {})
export const disconnectAction = createDisconnectAction({})
export const updateThing = async () => {}
export async function readThing() {}
export { helper }
export default updateThing
`
    expect(plainServerActionExports("fixture.ts", source)).toEqual([
      "updateThing",
      "readThing",
      "export { ... } export { helper }",
      "export default",
    ])
    expect(
      plainServerActionExports(
        "fixture.ts",
        source.replace('"use server"', 'import "server-only"'),
      ),
    ).toEqual([])
  })

  test("the scan sees the action files", () => {
    const useServerFiles = collectSourceFiles(SRC_ROOT).filter((filePath) =>
      hasUseServerDirective(parse(filePath, readFileSync(filePath, "utf8"))),
    )
    expect(useServerFiles.length).toBeGreaterThan(300)
  })

  test("no plain export outside the allowlist", () => {
    const offenders = collectSourceFiles(SRC_ROOT).flatMap((filePath) => {
      const relativePath = relative(SRC_ROOT, filePath).split("\\").join("/")
      const allowed = ALLOWED_PLAIN_EXPORTS[relativePath] ?? []
      return plainServerActionExports(filePath, readFileSync(filePath, "utf8"))
        .filter((name) => !allowed.includes(name))
        .map((name) => `${relativePath}: ${name}`)
    })

    expect(offenders).toEqual([])
  })

  test("every allowlisted export still exists", () => {
    for (const [relativePath, names] of Object.entries(ALLOWED_PLAIN_EXPORTS)) {
      const filePath = join(SRC_ROOT, relativePath)
      expect(
        plainServerActionExports(filePath, readFileSync(filePath, "utf8")),
      ).toEqual(names)
    }
  })
})
