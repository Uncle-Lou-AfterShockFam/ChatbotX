// @vitest-environment node

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { describe, expect, test } from "vitest"

/**
 * s205 gate: a list endpoint caps a page at 50 rows (`maxLimit` in
 * `@chatbotx.io/database/utils`), so asking for more in ONE call silently
 * truncates. "Load everything" goes through `fetchAllListPages`
 * (`src/lib/query/fetch-all-list-pages.ts`). This fails a `perPage` literal
 * above 50 and any use of the retired `maxPerPage`.
 */
const SERVER_PAGE_CAP = 50
const SOURCE_FILE = /\.(ts|tsx)$/
const TEST_FILE = /\.test\.tsx?$/
const RETIRED = /^maxPerPage/
const QUOTES = /["']/g
const SEPARATORS = /_/g
const SRC = join(import.meta.dirname, "../src")

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      return name === "__tests__" || name === "node_modules"
        ? []
        : sourceFiles(path)
    }
    return SOURCE_FILE.test(name) && !TEST_FILE.test(name) ? [path] : []
  })

const pageValue = (init: ts.Expression): number => {
  if (ts.isNumericLiteral(init)) {
    return Number(init.text.replace(SEPARATORS, ""))
  }
  if (ts.isStringLiteral(init)) {
    return Number(init.text)
  }
  return Number.NaN
}

const scanPageCap = (fileName: string, text: string): string[] => {
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
  const hits: string[] = []
  const at = (node: ts.Node) =>
    `${fileName}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(file).replace(QUOTES, "") === "perPage"
    ) {
      const value = pageValue(node.initializer)
      if (value > SERVER_PAGE_CAP) {
        hits.push(`${at(node)} perPage ${value}`)
      }
    }
    if (ts.isIdentifier(node) && RETIRED.test(node.text)) {
      hits.push(`${at(node)} ${node.text}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return hits
}

describe("list page cap gate (s205)", () => {
  test("no builder source asks one call for more than 50 rows", () => {
    const hits = sourceFiles(SRC).flatMap((path) =>
      scanPageCap(path.slice(SRC.length + 1), readFileSync(path, "utf8")),
    )
    expect(hits).toEqual([])
  })

  test.each([
    ["a large literal", "f({ perPage: 200 })"],
    ["a separator literal", "f({ perPage: 999_999_999 })"],
    ["a quoted key", 'f({ "perPage": 9999 })'],
    ["a numeric string", 'f({ perPage: "100" })'],
    ["the retired constant", "f({ perPage: maxPerPage })"],
    ["the retired string constant", "f({ perPage: maxPerPageString })"],
  ])("fails %s", (_, code) => {
    expect(scanPageCap("x.ts", code)).toHaveLength(1)
  })

  test.each([
    ["the cap itself", "f({ perPage: 50 })"],
    ["a small page", "f({ perPage: 20 })"],
    ["a variable", "f({ perPage: size })"],
    ["a comment", "// perPage: maxPerPage\nf()"],
  ])("passes %s", (_, code) => {
    expect(scanPageCap("x.ts", code)).toEqual([])
  })
})
