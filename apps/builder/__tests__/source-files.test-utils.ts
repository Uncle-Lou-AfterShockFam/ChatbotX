import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const TS_LIKE_EXTENSION_PATTERN = /\.(ts|tsx)$/

/** Every .ts/.tsx file under `dir`, skipping node_modules and __tests__. */
export function collectSourceFiles(dir: string, results: string[] = []) {
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
