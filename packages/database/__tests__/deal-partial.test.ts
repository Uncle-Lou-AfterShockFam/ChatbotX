import { describe, expect, test } from "vitest"
import {
  DEFAULT_PIPELINE_SETTINGS,
  DEFAULT_PIPELINE_STAGES,
  dealActivityTypes,
  dealStatuses,
  normalizeDealValue,
  pipelineSettingsSchema,
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
})
