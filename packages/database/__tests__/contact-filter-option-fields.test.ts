import { OPTION_ARRAY_PATTERN_SOURCE } from "@chatbotx.io/utils/custom-field"
import type { SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { describe, expect, test } from "vitest"
import {
  applyContactFilter,
  contactFilterHasPredicate,
} from "../src/queries/contact-filter"
import { contactModel } from "../src/schema"

/** s203: select / multiSelect conditions render their own SQL shape. */
const render = (
  customFieldType: string,
  operator: string,
  value?: unknown,
  valueType = customFieldType,
) => {
  const where = applyContactFilter({
    operator: "and",
    conditions: [
      {
        field: "customField",
        customFieldId: "cf-1",
        customFieldType,
        valueType,
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
    expect(q?.params).toContain(OPTION_ARRAY_PATTERN_SOURCE)
    expect(q?.sql).not.toContain("pg_input_is_valid")
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

  test("a pre-s203 condition (valueType text) on an option field keeps its text meaning", () => {
    expect(render("select", "contains", "Go", "text")?.sql).toContain("ILIKE")
    const legacyEq = render("select", "eq", "Gold", "text")
    expect(legacyEq?.sql).not.toContain("jsonb")
    expect(legacyEq?.params).toContain("Gold")
  })

  test("a malformed option condition is FALSE (never dropped), negatives included", () => {
    for (const [type, op, value] of [
      ["multiSelect", "in", []],
      ["multiSelect", "in", "Golf"],
      ["multiSelect", "notIn", "Golf"],
      ["multiSelect", "notIn", [""]],
      ["multiSelect", "startsWith", "Go"],
      ["select", "in", [" "]],
      ["select", "eq", ["Gold"]],
      ["select", "ne", ""],
    ] as const) {
      expect(render(type, op, value)?.sql, `${type} ${op}`).toBe("FALSE")
    }
    // an option valueType on a field of another type is not option-shaped
    expect(render("shortText", "in", ["a"], "multiSelect")).toBeUndefined()
  })

  test("AND with a malformed option condition never widens the audience", () => {
    const where = applyContactFilter({
      operator: "and",
      conditions: [
        {
          field: "customField",
          customFieldId: "cf-1",
          customFieldType: "multiSelect",
          valueType: "multiSelect",
          operator: "notIn",
          value: "Golf",
        },
        {
          field: "customField",
          customFieldId: "cf-2",
          customFieldType: "shortText",
          valueType: "text",
          operator: "eq",
          value: "vip",
        },
      ],
    } as never) as { AND?: unknown[] }
    expect(where.AND).toHaveLength(2)
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
    // malformed -> FALSE: still a predicate, so the step answers "no match"
    expect(contactFilterHasPredicate(criteria("in", []))).toBe(true)
  })
})
