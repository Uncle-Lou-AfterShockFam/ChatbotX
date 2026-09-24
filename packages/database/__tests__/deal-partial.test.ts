import { describe, expect, test } from "vitest"
import {
  DEFAULT_PIPELINE_SETTINGS,
  DEFAULT_PIPELINE_STAGES,
  dealActivityTypes,
  dealFieldDefsSchema,
  dealStatuses,
  normalizeDealValue,
  pipelineSettingsSchema,
  validateDealFields,
} from "../src/partials/deal"

describe("deal partials", () => {
  test("default stages carry exactly one won and one lost stage", () => {
    expect(DEFAULT_PIPELINE_STAGES.filter((s) => s.isWon)).toHaveLength(1)
    expect(DEFAULT_PIPELINE_STAGES.filter((s) => s.isLost)).toHaveLength(1)
    expect(
      DEFAULT_PIPELINE_STAGES[0].isWon || DEFAULT_PIPELINE_STAGES[0].isLost,
    ).toBe(false)
  })

  test("pipeline settings fill defaults and upper-case the currency", () => {
    expect(pipelineSettingsSchema.parse({})).toEqual(DEFAULT_PIPELINE_SETTINGS)
    expect(pipelineSettingsSchema.parse({ defaultCurrency: "eur" })).toEqual({
      stopCompanyOn: "created",
      defaultCurrency: "EUR",
      fieldDefs: [],
    })
  })

  test.each([
    [{ stopCompanyOn: "always" }, "unknown stopCompanyOn"],
    [{ defaultCurrency: "EURO" }, "4-letter currency"],
    [{ defaultCurrency: "" }, "empty currency"],
    [null, "null"],
  ])("pipeline settings reject %j (%s)", (input) => {
    expect(pipelineSettingsSchema.safeParse(input).success).toBe(false)
  })

  test.each([
    ["100", "100.00"],
    [100, "100.00"],
    ["1,250.5", "1250.50"],
    [" 7 ", "7.00"],
    ["0", "0.00"],
    [0.005, "0.01"],
  ])("normalizeDealValue(%j) -> %s", (input, expected) => {
    expect(normalizeDealValue(input)).toBe(expected)
  })

  test.each([
    [null, "null"],
    [undefined, "undefined"],
    ["", "empty"],
    ["abc", "letters"],
    ["-5", "negative"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
    ["1e12", "too large for numeric(14,2)"],
    [{}, "object"],
    [[1], "array"],
  ])("normalizeDealValue(%j) is null (%s)", (input) => {
    expect(normalizeDealValue(input)).toBeNull()
  })

  test("the same value normalises identically from number and string", () => {
    expect(normalizeDealValue(1250.5)).toBe(normalizeDealValue("1250.50"))
  })

  test("every activity type names a deal event or a note", () => {
    expect(dealActivityTypes.options).toContain("note")
    expect(dealStatuses.options).toEqual(["open", "won", "lost"])
  })

  test("every phase-2 activity type is declared", () => {
    for (const type of [
      "titleChanged",
      "currencyChanged",
      "dueAtChanged",
      "fieldChanged",
    ]) {
      expect(dealActivityTypes.options).toContain(type)
    }
  })
})

const SELECT = {
  key: "roofType",
  label: "Roof type",
  type: "select",
  options: ["metal", "shingle"],
}
const DEFS = dealFieldDefsSchema.parse([
  SELECT,
  { key: "sqft", label: "Sq ft", type: "number", required: true },
  { key: "signed", label: "Signed", type: "boolean" },
  { key: "closeOn", label: "Close on", type: "date" },
  { key: "memo", label: "Memo", type: "longText" },
])

describe("dealFieldDefsSchema", () => {
  test("parses a valid list, defaults required to false", () => {
    expect(DEFS[0]).toEqual({ ...SELECT, required: false })
    expect(DEFS).toHaveLength(5)
  })

  test.each([
    [[{ key: "Roof", label: "x", type: "shortText" }], "uppercase first char"],
    [[{ key: "a".repeat(41), label: "x", type: "shortText" }], "key too long"],
    [[{ key: "a", label: "", type: "shortText" }], "empty label"],
    [[{ key: "a", label: "x", type: "colour" }], "unknown type"],
    [[{ key: "a", label: "x", type: "select" }], "select without options"],
    [
      [{ key: "a", label: "x", type: "select", options: ["a", "a"] }],
      "duplicate options",
    ],
    [
      [{ key: "a", label: "x", type: "number", options: ["a"] }],
      "options on a non-select",
    ],
    [
      [{ key: "a", label: "x", type: "shortText", extra: 1 }],
      "unknown key (closed)",
    ],
    [
      [
        { key: "a", label: "x", type: "shortText" },
        { key: "a", label: "y", type: "number" },
      ],
      "duplicate keys",
    ],
    [
      Array.from({ length: 31 }, (_, i) => ({
        key: `k${i}`,
        label: "x",
        type: "shortText",
      })),
      "31 defs",
    ],
    [null, "null"],
    [{}, "object"],
  ])("rejects %j (%s)", (input) => {
    expect(dealFieldDefsSchema.safeParse(input).success).toBe(false)
  })

  test("a legacy settings row without fieldDefs parses to []", () => {
    expect(
      pipelineSettingsSchema.parse({
        stopCompanyOn: "won",
        defaultCurrency: "EUR",
      }).fieldDefs,
    ).toEqual([])
  })
})

describe("validateDealFields", () => {
  test("a valid set against the defs has no issues; undeclared keys stay free-form", () => {
    expect(
      validateDealFields({
        defs: DEFS,
        fields: {
          roofType: "metal",
          sqft: 1200,
          signed: true,
          closeOn: "2026-10-01",
          memo: "hello",
          undeclared: { any: "thing" },
        },
        requireAll: true,
      }),
    ).toEqual([])
  })

  test.each([
    [{ roofType: "tile" }, "roofType"],
    [{ sqft: "1200" }, "sqft"],
    [{ signed: "yes" }, "signed"],
    [{ closeOn: "tomorrow" }, "closeOn"],
    [{ memo: 5 }, "memo"],
    [{ memo: "x".repeat(4001) }, "memo"],
  ])("%j is flagged on %s", (fields, key) => {
    const issues = validateDealFields({ defs: DEFS, fields })
    expect(issues.map((i) => i.key)).toEqual([key])
  })

  test("null clears an optional field but not a required one", () => {
    expect(
      validateDealFields({ defs: DEFS, fields: { roofType: null } }),
    ).toEqual([])
    expect(validateDealFields({ defs: DEFS, fields: { sqft: null } })).toEqual([
      { key: "sqft", message: "is required" },
    ])
  })

  test("requireAll flags a missing required key only on request", () => {
    expect(validateDealFields({ defs: DEFS, fields: {} })).toEqual([])
    expect(
      validateDealFields({ defs: DEFS, fields: {}, requireAll: true }),
    ).toEqual([{ key: "sqft", message: "is required" }])
  })

  test.each([
    [null, "null"],
    [undefined, "undefined"],
    ["text", "string"],
    [[1], "array"],
    [42, "number"],
  ])("a non-object (%s) is one issue on 'fields'", (input) => {
    expect(validateDealFields({ defs: DEFS, fields: input })).toEqual([
      { key: "fields", message: "must be an object" },
    ])
  })

  test("caps: more than 50 keys, more than 8 KiB, and a cyclic object", () => {
    const many = Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [`k${i}`, i]),
    )
    expect(validateDealFields({ defs: [], fields: many })[0].message).toMatch(
      "more than 50",
    )
    expect(
      validateDealFields({ defs: [], fields: { memo: "x".repeat(9000) } })[0]
        .message,
    ).toContain("exceeds 8192")
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(validateDealFields({ defs: [], fields: cyclic })[0].message).toMatch(
      "serialisable",
    )
  })

  test("the byte cap counts UTF-8 bytes, not UTF-16 code units", () => {
    // 3,000 CJK chars = 3,000 code units but 9,000 UTF-8 bytes.
    const cjk = { memo: "\u5b57".repeat(3000) }
    expect(validateDealFields({ defs: [], fields: cjk })[0]?.message).toContain(
      "exceeds 8192",
    )
    expect(
      validateDealFields({ defs: [], fields: { memo: "x".repeat(8000) } }),
    ).toEqual([])
  })

  test("missing defs behave as an empty list", () => {
    expect(validateDealFields({ defs: undefined, fields: { a: 1 } })).toEqual(
      [],
    )
  })
})
