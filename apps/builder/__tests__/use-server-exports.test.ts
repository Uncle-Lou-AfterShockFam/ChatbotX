// @vitest-environment node

import { readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import ts from "typescript"
import { describe, expect, test } from "vitest"
import {
  chainRoot,
  hasUseServerDirective,
  parseSource as parse,
} from "./server-action-exports.test-utils"
import { collectSourceFiles } from "./source-files.test-utils"

const SRC_ROOT = join(import.meta.dirname, "..", "src")

// s232a: every value export of a "use server" file is a Server Action that
// anyone holding its id can POST to, with arguments of their choosing. A
// plain helper exported next to its safe-action wrapper skips the wrapper's
// session + workspace check and its zod parse: `updateIntegrationOpenAI`
// updated any workspace's row and returned it with the API key, and
// `updateMessenger` / `updateMagicLink` wrote unparsed columns. Helpers live
// in `import "server-only"` modules (or stay unexported); a "use server" file
// exports only values built from a safe-action client (lib/safe-action.ts)
// or the integration disconnect factory built on one.
// The modules a wrapper may be built from, src-relative without extension.
// The root of the export's call chain must be a binding IMPORTED from one of
// them; a name that merely looks like a client (`myActionClient`) does not
// count.
const SAFE_ACTION_MODULES = new Set([
  "lib/safe-action",
  "lib/integration-actions",
])

// Plain Server Actions that are called from the browser on purpose. Each
// touches only the caller's own cookie and validates its input itself.
const ALLOWED_PLAIN_EXPORTS: Record<string, string[]> = {
  "lib/locale.ts": ["getUserLocale", "setUserLocale"],
  "lib/timezone.action.ts": ["setUserTimezone"],
}

function resolveSpecifier(fileName: string, specifier: string) {
  if (specifier.startsWith("@/")) {
    return join(SRC_ROOT, specifier.slice(2))
  }
  if (specifier.startsWith(".")) {
    return resolve(dirname(fileName), specifier)
  }
  return null
}

/** Import bindings of a file: local name -> src-relative module, if resolvable. */
function importedModules(fileName: string, sourceFile: ts.SourceFile) {
  const modules = new Map<string, string>()
  for (const statement of sourceFile.statements) {
    if (
      !(
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) ||
      statement.importClause?.isTypeOnly
    ) {
      continue
    }
    const absolute = resolveSpecifier(fileName, statement.moduleSpecifier.text)
    const bindings = statement.importClause?.namedBindings
    if (!(absolute && bindings && ts.isNamedImports(bindings))) {
      continue
    }
    const module = relative(SRC_ROOT, absolute).split("\\").join("/")
    for (const element of bindings.elements) {
      if (!element.isTypeOnly) {
        modules.set(element.name.text, module)
      }
    }
  }
  return modules
}

function isSafeActionValue(
  initializer: ts.Expression | undefined,
  modules: Map<string, string>,
) {
  const root = chainRoot(initializer)
  const module = root === null ? undefined : modules.get(root)
  return module !== undefined && SAFE_ACTION_MODULES.has(module)
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

  const modules = importedModules(fileName, sourceFile)
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
        if (!isSafeActionValue(declaration.initializer, modules)) {
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
import { createDisconnectAction } from "@/lib/integration-actions"
import { myActionClient } from "./helpers"
export type Row = { id: string }
export const lookAlike = myActionClient.action(async () => {})
export const updateThingAction = workspaceActionClient
  .inputSchema(schema)
  .action(async () => {})
export const disconnectAction = createDisconnectAction({})
export const updateThing = async () => {}
export async function readThing() {}
export { helper }
export default updateThing
`
    const fixture = join(SRC_ROOT, "features/fixture/actions/fixture.ts")
    expect(plainServerActionExports(fixture, source)).toEqual([
      "lookAlike",
      "updateThing",
      "readThing",
      "export { ... } export { helper }",
      "export default",
    ])
    expect(
      plainServerActionExports(
        fixture,
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
