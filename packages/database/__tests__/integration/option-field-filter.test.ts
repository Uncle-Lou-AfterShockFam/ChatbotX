// @vitest-environment node

/**
 * s203: the select / multiSelect filter SQL against a real PostgreSQL, and its
 * agreement with the JS evaluator the value-changed trigger uses
 * (`matchesOptionCondition`). The render tests only prove the SQL's shape; the
 * `::jsonb` cast throws on non-JSON text, so only a real database proves a
 * legacy or malformed stored value never aborts a contact list or a flow
 * Condition step.
 *
 * Writes only TEMP tables. Skipped unless `DATABASE_URL` points at a reachable
 * database; run it with `pnpm --filter @chatbotx.io/database test:db`.
 */

import {
  matchesOptionCondition,
  OPTION_FIELD_OPERATORS,
  type OptionFieldType,
} from "@chatbotx.io/utils/custom-field"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { sql } from "drizzle-orm"
import { PgDialect, pgTable, text } from "drizzle-orm/pg-core"
import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { resolveFieldValueNegation } from "../../src/queries/contact-filter/field-value-predicates"
import { buildOptionFieldPredicate } from "../../src/queries/contact-filter/option-field-predicates"

const databaseUrl = requireRealDatabaseUrl()

// Same shape as Contact + ContactCustomField: one optional value per contact.
const probe = pgTable("s203_option_probe", {
  contactId: text("contactId"),
  value: text("value"),
})

const OPTIONS = ["Golf", "Hiking", "Red, White", "Bronze"]

/** contactId -> stored value; null = the contact has no row. */
const FIXED: Record<string, string | null> = {
  none: null,
  blank: "",
  spaces: "   ",
  empty: "[]",
  golf: '["Golf"]',
  comma: '["Golf","Red, White"]',
  all: JSON.stringify(OPTIONS),
  legacy: "Golf",
  legacyComma: "Golf, Hiking",
  malformed: '["Golf"',
  object: '{"Golf":1}',
  number: "5",
  mixed: '["Golf",1]',
  nested: '[["Golf"]]',
  quoted: '"Golf"',
  bracketText: "[Golf",
  // s203 blind probe: every row below once threw or made SQL and JS disagree.
  deepNest: `${"[".repeat(100_000)}${"]".repeat(100_000)}`,
  deepOpen: "[".repeat(25_000),
  bom: '\uFEFF["Golf"]',
  nbspLead: '\u00A0["Golf"]',
  ideographicLead: '\u3000["Golf"]',
  verticalTab: '\u000B["Golf"]',
  lineSep: '\u2028["Golf"]',
  bomOnly: "\uFEFF",
  nbspOnly: "\u00A0",
  jsonWhitespace: ' \t["Golf"]\n ',
  nulEscape: '["Golf","\\u0000"]',
  surrogateEscape: '["Golf","\\ud800"]',
  pairedEscape: '["\\ud83d\\ude00"]',
  hugeNumber: '["Golf",1e1000000]',
  accentEscape: '["Caf\\u00e9"]',
  emptyItem: '[""]',
  nullItem: "[null]",
}

/** Deterministic PRNG (Park-Miller) so a failure reproduces. */
const rng = (seed: number) => {
  let state = seed
  return () => {
    state = (state * 48_271) % 2_147_483_647
    return state / 2_147_483_647
  }
}
const subset = (next: () => number) => OPTIONS.filter(() => next() < 0.5)

describe.skipIf(!databaseUrl)(
  "option-field filter SQL against a real PostgreSQL",
  () => {
    let client: Client
    const stored: Record<string, string | null> = { ...FIXED }

    beforeAll(async () => {
      client = new Client({ connectionString: databaseUrl as string })
      await client.connect()
      await client.query(
        `CREATE TEMP TABLE "s203_option_contact" ("id" text PRIMARY KEY)`,
      )
      await client.query(
        `CREATE TEMP TABLE "s203_option_probe" ("contactId" text, "value" text)`,
      )
      const next = rng(203)
      for (let i = 0; i < 40; i++) {
        const picked = subset(next)
        stored[`random${i}`] = picked.length === 0 ? "" : JSON.stringify(picked)
      }
      for (const [id, value] of Object.entries(stored)) {
        await client.query(`INSERT INTO "s203_option_contact" VALUES ($1)`, [
          id,
        ])
        if (value !== null) {
          await client.query(
            `INSERT INTO "s203_option_probe" VALUES ($1, $2)`,
            [id, value],
          )
        }
      }
    })

    afterAll(async () => {
      await client?.end()
    })

    /** The contacts the filter selects, built exactly as `buildCustomFieldWhere` does. */
    const sqlMatches = async (
      type: OptionFieldType,
      operator: string,
      value: unknown,
    ): Promise<string[]> => {
      const { positiveOperator, negate } = resolveFieldValueNegation(operator)
      const predicate = buildOptionFieldPredicate({
        column: probe.value,
        customFieldType: type,
        valueType: type,
        operator: positiveOperator,
        value,
      })
      expect(predicate, `${type} ${operator} compiles`).toBeDefined()
      const inner = sql`SELECT 1 FROM ${probe} WHERE ${probe.contactId} = c."id" AND ${predicate}`
      const query = new PgDialect().sqlToQuery(
        sql`SELECT c."id" FROM "s203_option_contact" c WHERE ${sql.raw(negate ? "NOT " : "")}EXISTS (${inner}) ORDER BY c."id"`,
      )
      const { rows } = await client.query<{ id: string }>(
        query.sql,
        query.params,
      )
      return rows.map((row) => row.id)
    }

    const jsMatches = (
      type: OptionFieldType,
      operator: string,
      value: unknown,
    ) =>
      Object.keys(stored)
        .filter((id) =>
          matchesOptionCondition(type, operator, stored[id], value),
        )
        .sort()

    const valueFor = (
      type: OptionFieldType,
      operator: string,
      list: string[],
    ) => {
      if (operator === "isEmpty" || operator === "isNotEmpty") {
        return
      }
      return type === "select" && (operator === "eq" || operator === "ne")
        ? list[0]
        : list
    }

    test("pinned multiSelect answers, hostile rows included", async () => {
      expect(await sqlMatches("multiSelect", "in", ["Red, White"])).toEqual(
        expect.arrayContaining(["all", "comma"]),
      )
      const golfAny = await sqlMatches("multiSelect", "in", ["Golf"])
      for (const id of ["golf", "comma", "all", "legacy"]) {
        expect(golfAny).toContain(id)
      }
      for (const id of [
        "none",
        "blank",
        "malformed",
        "object",
        "nested",
        "quoted",
        "mixed", // a non-string element: not a flat string array -> legacy
      ]) {
        expect(golfAny).not.toContain(id)
      }
      const golfNone = await sqlMatches("multiSelect", "notIn", ["Golf"])
      expect(golfNone).toContain("none")
      expect(golfNone).not.toContain("comma")
      expect(await sqlMatches("multiSelect", "eq", ["Golf"])).toEqual(
        expect.arrayContaining(["golf", "legacy"]),
      )
      expect(await sqlMatches("multiSelect", "eq", ["Golf"])).not.toContain(
        "mixed",
      )
      const empty = await sqlMatches("multiSelect", "isEmpty", undefined)
      expect(empty).toEqual(
        expect.arrayContaining(["none", "blank", "spaces", "empty"]),
      )
      expect(empty).not.toContain("malformed")
    })

    test("no stored value makes the SQL throw (deep nesting, bad escapes)", async () => {
      for (const operator of OPTION_FIELD_OPERATORS.multiSelect) {
        await expect(
          sqlMatches(
            "multiSelect",
            operator,
            valueFor("multiSelect", operator, ["Golf"]),
          ),
        ).resolves.toBeDefined()
      }
      const golfAny = await sqlMatches("multiSelect", "in", ["Golf"])
      for (const id of [
        "bom",
        "nbspLead",
        "nulEscape",
        "hugeNumber",
        "deepNest",
      ]) {
        expect(golfAny).not.toContain(id) // not a flat string array -> legacy
      }
      expect(golfAny).toContain("jsonWhitespace")
      expect(await sqlMatches("multiSelect", "in", ["Café"])).toContain(
        "accentEscape",
      )
    })

    test("SQL and the JS evaluator agree on every operator (seeded property)", async () => {
      const next = rng(2030)
      for (const type of ["select", "multiSelect"] as const) {
        for (const operator of OPTION_FIELD_OPERATORS[type]) {
          for (let round = 0; round < 12; round++) {
            let list = subset(next)
            if (list.length === 0) {
              list = [OPTIONS[round % OPTIONS.length] as string]
            }
            if (round % 4 === 1) {
              // hostile filter text, compared literally on both sides
              list = ['["Golf"]', "\uFEFFGolf", "%_'$1?|", "Café"].slice(
                0,
                1 + (round % 3),
              )
            }
            if (type === "select" && round % 3 === 0) {
              list = ["Golf", "[Golf", '"Golf"', "5"].slice(0, 1 + (round % 4))
            }
            const value = valueFor(type, operator, list)
            expect(
              await sqlMatches(type, operator, value),
              `${type} ${operator} ${JSON.stringify(value)}`,
            ).toEqual(jsMatches(type, operator, value))
          }
        }
      }
    })
  },
)
