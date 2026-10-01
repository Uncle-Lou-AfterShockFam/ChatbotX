import ts from "typescript"

/** Shared by the "use server" scanners (s232a exports, s233a/s234a permission gates). */
export function parseSource(fileName: string, source: string) {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

export function hasUseServerDirective(sourceFile: ts.SourceFile) {
  const first = sourceFile.statements[0]
  return (
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === "use server"
  )
}

/** The identifier a call/property chain starts from: `a.b().c()` -> `a`. */
export function chainRoot(
  expression: ts.Expression | undefined,
): string | null {
  let current = expression
  while (
    current &&
    (ts.isCallExpression(current) ||
      ts.isPropertyAccessExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression
  }
  return current && ts.isIdentifier(current) ? current.text : null
}

/**
 * Every value export of a "use server" file and the client it is built on
 * (`root: null` for functions, re-exports and default exports).
 */
export function serverActionExports(fileName: string, source: string) {
  const file = parseSource(fileName, source)
  if (!hasUseServerDirective(file)) {
    return []
  }
  const found: { name: string; root: string | null }[] = []
  for (const statement of file.statements) {
    const exported = ts
      .getModifiers(statement as ts.HasModifiers)
      ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    if (ts.isVariableStatement(statement) && exported) {
      for (const decl of statement.declarationList.declarations) {
        found.push({
          name: decl.name.getText(),
          root: chainRoot(decl.initializer),
        })
      }
    } else if (ts.isFunctionDeclaration(statement) && exported) {
      found.push({ name: statement.name?.text ?? "default", root: null })
    } else if (
      ts.isExportAssignment(statement) ||
      (ts.isExportDeclaration(statement) && !statement.isTypeOnly)
    ) {
      found.push({ name: statement.getText(), root: null })
    }
  }
  return found
}
