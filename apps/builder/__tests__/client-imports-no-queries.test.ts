// @vitest-environment node

import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join, sep } from "node:path"
import ts from "typescript"
import { describe, expect, test } from "vitest"
import { collectSourceFiles } from "./source-files.test-utils"

const APP_ROOT = join(import.meta.dirname, "..")
const SRC_ROOT = join(APP_ROOT, "src")
const USE_CLIENT_DIRECTIVE_PATTERN = /^["']use client["']\s*;?\s*$/
const USE_SERVER_DIRECTIVE_PATTERN = /^["']use server["']\s*;?\s*$/
const SERVER_ONLY_IMPORT_PATTERN = /^import ["']server-only["']\s*;?\s*$/m
const QUERIES_DIR_SEGMENT = `${sep}queries${sep}`
// Matches a relative or `@/features/<feature>` specifier whose last path
// segment is exactly `queries`, or a direct file inside such a directory
// (e.g. `../queries`, `./queries/files`, `@/features/tags/queries`) — the
// `apps/builder/src/features/*/queries/` request-adapter modules described
// in .agents/rules/data-access.md.
const QUERIES_MODULE_SPECIFIER_PATTERN =
  /^(?:\.\.?\/|@\/features\/)(?:[\w-]+\/)*queries(?:\/[\w-]+)?$/

// A `features/*/queries` module that is itself marked "use server" compiles
// into a Next.js Server Actions module: every export becomes an invokable
// server reference, reachable over the network by anyone who can guess or
// intercept its action-ID hash, bypassing the oRPC/action auth middleware
// that is supposed to gate that data (see .agents/rules/data-access.md).
// A "use client" component must reach that data through the oRPC client or
// TanStack Query instead — see media-library-trigger.tsx, which used to
// value-import `../queries/files` and `../queries/folders` directly and only
// worked because those two modules were (incorrectly) marked "use server".
//
// Not every file under `queries/` carries that risk: a plain helper with no
// "use server" directive (e.g. a pure formatting function colocated there)
// is just an ordinary module and is not flagged — only resolving the
// specifier to its actual file tells them apart from the barrel/adapter
// files that need the guard. `import type { ... }` (and `import { type Foo
// }` where every named specifier is type-only) is fine regardless; only a
// value import into a "use server" file is a boundary violation.
// Blank lines, `//` lines and `/* ... */` blocks ahead of the first statement.
const LEADING_COMMENTS_PATTERN = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/

/** The first statement's line, past any leading comments. */
function firstStatementLine(source: string) {
  const rest = source.replace(LEADING_COMMENTS_PATTERN, "")
  return rest.split("\n", 1)[0].trim()
}

function isClientFile(source: string) {
  return USE_CLIENT_DIRECTIVE_PATTERN.test(firstStatementLine(source))
}

function isQueriesModuleSpecifier(specifier: string) {
  return QUERIES_MODULE_SPECIFIER_PATTERN.test(specifier)
}

const RESOLVE_CANDIDATE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  "/index.ts",
  "/index.tsx",
]

/** Resolves a relative or `@/`-aliased specifier to a file under SRC_ROOT, if one exists. */
function resolveModuleSpecifier(importingFilePath: string, specifier: string) {
  const basePath = specifier.startsWith("@/")
    ? join(SRC_ROOT, specifier.slice(2))
    : join(dirname(importingFilePath), specifier)

  for (const suffix of RESOLVE_CANDIDATE_SUFFIXES) {
    const candidate = `${basePath}${suffix}`
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate
    }
  }
  return null
}

/** True if the source's leading directive is "use server". */
function hasUseServerDirective(source: string) {
  return USE_SERVER_DIRECTIVE_PATTERN.test(firstStatementLine(source))
}

/** True if the resolved file is a server boundary: "use server" or `import "server-only"`. */
function isServerBoundaryFile(resolvedPath: string) {
  const source = readFileSync(resolvedPath, "utf8")
  return (
    hasUseServerDirective(source) || SERVER_ONLY_IMPORT_PATTERN.test(source)
  )
}

/** True if this import/export clause pulls in at least one runtime value. */
function hasValueBinding(
  clause: ts.ImportClause | undefined,
): clause is ts.ImportClause {
  if (!clause) {
    return false
  }
  if (clause.isTypeOnly) {
    return false
  }
  if (clause.name) {
    // default import, e.g. `import Foo from "..."`
    return true
  }
  const bindings = clause.namedBindings
  if (!bindings) {
    return false
  }
  if (ts.isNamespaceImport(bindings)) {
    // `import * as foo from "..."`
    return true
  }
  // named imports: `{ a, type B }` — a value import unless every element is type-only
  return bindings.elements.some((el) => !el.isTypeOnly)
}

function findQueriesValueImports(filePath: string, source: string) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  const offenders: string[] = []

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue
    }
    if (!ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }
    const specifier = statement.moduleSpecifier.text
    if (!isQueriesModuleSpecifier(specifier)) {
      continue
    }
    if (!hasValueBinding(statement.importClause)) {
      continue
    }

    const resolved = resolveModuleSpecifier(filePath, specifier)
    // A directory import (e.g. `../queries`) resolves to its `index.ts`
    // barrel, which is the adapter surface itself — flag it. An
    // unresolvable specifier is flagged conservatively rather than silently
    // skipped.
    if (!resolved || isServerBoundaryFile(resolved)) {
      offenders.push(specifier)
    }
  }

  return offenders
}

describe("client components do not value-import features/*/queries modules", () => {
  test('no "use client" file value-imports a queries module', () => {
    const offenders = collectSourceFiles(SRC_ROOT).flatMap((filePath) => {
      const source = readFileSync(filePath, "utf8")
      if (!isClientFile(source)) {
        return []
      }

      return findQueriesValueImports(filePath, source).map(
        (specifier) => `${filePath} -> "${specifier}"`,
      )
    })

    expect(offenders).toEqual([])
  })
})

// s232a: a "use server" queries module turns every export into a network-
// callable Server Action, and several of these take a caller-supplied
// workspaceId/userId with no membership check (listWorkspaceMembers,
// getAllWorkspaceMembers, findIntegrationWebchat returned the full row with
// `auth`). Queries are server-only reads: `import "server-only"`, never
// "use server". Mutations that must be callable from the browser belong in
// `actions/` behind the safe-action clients (lib/safe-action.ts).
describe('features/*/queries modules are never "use server"', () => {
  test("the directive detector fires on a fixture", () => {
    expect(
      hasUseServerDirective('// note\n"use server"\n\nexport const x = 1'),
    ).toBe(true)
    expect(hasUseServerDirective("'use server';\n")).toBe(true)
    expect(
      hasUseServerDirective('/* license\n * header\n */\n"use server"\n'),
    ).toBe(true)
    expect(isClientFile('/* eslint-disable */\n"use client"\n')).toBe(true)
    expect(SERVER_ONLY_IMPORT_PATTERN.test('import "server-only";\n')).toBe(
      true,
    )
    expect(hasUseServerDirective('import "server-only"\n')).toBe(false)
    expect(SERVER_ONLY_IMPORT_PATTERN.test('import "server-only"\n')).toBe(true)
  })

  test("the scan sees the queries modules", () => {
    const queriesFiles = collectSourceFiles(SRC_ROOT).filter((filePath) =>
      filePath.includes(QUERIES_DIR_SEGMENT),
    )
    expect(queriesFiles.length).toBeGreaterThan(10)
  })

  test('no file under a queries/ directory carries "use server"', () => {
    const offenders = collectSourceFiles(SRC_ROOT).filter(
      (filePath) =>
        filePath.includes(QUERIES_DIR_SEGMENT) &&
        hasUseServerDirective(readFileSync(filePath, "utf8")),
    )

    expect(offenders).toEqual([])
  })
})
