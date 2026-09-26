import type { SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { describe, expect, test } from "vitest"
import {
  applyContactFilter,
  contactFilterHasPredicate,
} from "../src/queries/contact-filter"
import { contactModel } from "../src/schema"

/** s203: select / multiSelect conditions render their own SQL shape. */
const render = (customFieldType: string, operator: string, value?: unknown) => {
  const where = applyContactFilter({
    operator: "and",
    conditions: [
      {
        field: "customField",
        customFieldId: "cf-1",
        customFieldType,
        valueType: customFieldType === "multiSelect" ? "multiSelect" : "select",
        operator,
        ...(value === undefined ? {} : { value }),
      },
    ],
  } as never)
  const raw = (where as { AND?: Array<{ RAW?: unknown }> }).AND?.[0]?.RAW
  if (typeof raw !== "function") {
    return
  }
  return new PgDialect().sqlToQuery(
    (raw as (table: typeof contactModel) => SQL)(contactModel),
  )
}

describe("applyContactFilter — option fields (s203)", () => {
  test("multiSelect in = any-of over the guarded items, EXISTS", () => {
    const q = render("multiSelect", "in", ["Golf", "Red, White"])
    expect(q?.sql.startsWith("EXISTS")).toBe(true)
    expect(q?.sql).toContain("pg_input_is_valid")
    expect(q?.sql).toContain("jsonb_array_elements(")
    expect(q?.params).toContain('["Golf","Red, White"]')
  })

  test("multiSelect notIn / ne / isEmpty negate the positive with NOT EXISTS", () => {
    for (const [op, value] of [
      ["notIn", ["Golf"]],
      ["ne", ["Golf"]],
      ["isEmpty", undefined],
    ] as const) {
      const q = render("multiSelect", op, value)
      expect(q?.sql.startsWith("NOT EXISTS")).toBe(true)
      expect(q?.sql).toContain("CASE WHEN")
    }
  })

  test("multiSelect contains = @>, eq = exact set", () => {
    expect(render("multiSelect", "contains", ["Golf"])?.sql).toContain("@>")
    const eq = render("multiSelect", "eq", ["Golf"])?.sql
    expect(eq).toContain("@>")
    expect(eq).toContain("<@")
  })

  test("select in = ANY over the list parameter; notIn negates", () => {
    const q = render("select", "in", ["Gold", "Silver"])
    expect(q?.sql).toContain("= ANY(ARRAY(SELECT jsonb_array_elements_text(")
    expect(q?.params).toContain('["Gold","Silver"]')
    expect(
      render("select", "notIn", ["Gold"])?.sql.startsWith("NOT EXISTS"),
    ).toBe(true)
  })

  test("a pre-s203 text condition on an option field keeps its text meaning", () => {
    expect(render("select", "contains", "Go")?.sql).toContain("ILIKE")
    const legacyEq = render("multiSelect", "eq", '["Golf"]')
    expect(legacyEq?.sql).not.toContain("jsonb")
    expect(legacyEq?.params).toContain('["Golf"]')
  })

  test("an invalid option condition is dropped, never compiled", () => {
    expect(render("multiSelect", "in", [])).toBeUndefined()
    expect(render("multiSelect", "in", "Golf")).toBeUndefined()
    expect(render("select", "in", [" "])).toBeUndefined()
  })

  test("a flow Condition step on a multiSelect has a predicate (never the all-dropped false)", () => {
    const criteria = (operator: string, value: unknown) =>
      ({
        operator: "and",
        conditions: [
          {
            field: "customField",
            customFieldId: "cf-1",
            customFieldType: "multiSelect",
            valueType: "multiSelect",
            operator,
            value,
          },
        ],
      }) as never
    expect(contactFilterHasPredicate(criteria("contains", ["Golf"]))).toBe(true)
    expect(contactFilterHasPredicate(criteria("notIn", ["Golf"]))).toBe(true)
    expect(contactFilterHasPredicate(criteria("in", []))).toBe(false)
  })
})
