import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

/**
 * Next.js refuses to boot when two sibling dynamic segments use different
 * slug names ("You cannot use different slug names for the same dynamic
 * path"). Nothing in tsc, vitest or biome catches it - the builder image
 * crash-looped in production over `l/[token]` next to `l/[workspaceId]`
 * (s165). This walks the app tree and fails on the first such pair.
 */
const APP_DIR = join(import.meta.dirname, "..", "src", "app")

const isDynamic = (name: string) => name.startsWith("[") && name.endsWith("]")

function conflicts(dir: string, out: string[]): void {
  const entries = readdirSync(dir).filter((e) =>
    statSync(join(dir, e)).isDirectory(),
  )
  const dynamic = new Set(entries.filter(isDynamic))
  if (dynamic.size > 1) {
    out.push(`${dir}: ${[...dynamic].join(" vs ")}`)
  }
  for (const e of entries) {
    if (e.startsWith("node_modules")) {
      continue
    }
    conflicts(join(dir, e), out)
  }
}

describe("app router slugs", () => {
  test("no directory holds two dynamic segments with different names", () => {
    const found: string[] = []
    conflicts(APP_DIR, found)
    expect(found).toEqual([])
  })
})
