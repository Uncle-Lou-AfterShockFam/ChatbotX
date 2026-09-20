// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import en from "../messages/en.json"

/**
 * Every `messages.*` string that interpolates `{feature}` must be called with
 * a `feature` value. `t("messages.updatedSuccess")` with no values type-checks
 * and passes `i18n-source-keys`, but at runtime next-intl raises
 * FORMATTING_ERROR and the fallback renders the raw template - the API-channel
 * settings dialog shipped that way (s165: two browser runs never saw its
 * save toast). A second argument is required; its shape is left to tsc.
 */

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url))
const SOURCE_FILE = /\.(ts|tsx)$/

const featureKeys = Object.entries(
  (en as { messages: Record<string, unknown> }).messages,
).flatMap(([key, value]) =>
  typeof value === "string" && value.includes("{feature}") ? [key] : [],
)

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (SOURCE_FILE.test(entry.name)) {
      yield full
    }
  }
}

test("en.json has messages that interpolate {feature}", () => {
  expect(featureKeys).toContain("updatedSuccess")
})

test("no source calls a {feature} message without a values argument", () => {
  const bare = new RegExp(
    `\\bt[A-Za-z0-9_$]*\\(\\s*["'](?:messages\\.)(${featureKeys.join("|")})["']\\s*\\)`,
    "g",
  )
  const offenders: string[] = []
  for (const file of walk(SRC_DIR)) {
    const source = readFileSync(file, "utf8")
    for (const match of source.matchAll(bare)) {
      const line = source.slice(0, match.index).split("\n").length
      offenders.push(`${path.relative(SRC_DIR, file)}:${line} ${match[0]}`)
    }
  }
  expect(offenders).toEqual([])
})
