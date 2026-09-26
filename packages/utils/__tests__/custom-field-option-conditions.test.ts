import { describe, expect, test } from "vitest"
import {
  MAX_CUSTOM_FIELD_OPTIONS,
  matchesOptionCondition,
  OPTION_FIELD_OPERATORS,
  optionConditionIssue,
  optionOperatorTakesList,
} from "../src/custom-field"

const STORED = '["Golf","Red, White"]'

describe("optionConditionIssue (s203)", () => {
  test("accepts exactly the operator table", () => {
    expect(optionConditionIssue("select", "eq", "Gold")).toBeNull()
    expect(optionConditionIssue("select", "in", ["Gold"])).toBeNull()
    expect(optionConditionIssue("multiSelect", "contains", ["Golf"])).toBeNull()
    expect(optionConditionIssue("multiSelect", "eq", ["Golf"])).toBeNull()
    expect(optionConditionIssue("multiSelect", "isEmpty", undefined)).toBeNull()
    for (const op of ["startsWith", "notContains", "gt", "isBetween", "used"]) {
      expect(optionConditionIssue("select", op, "Gold")).not.toBeNull()
      expect(optionConditionIssue("multiSelect", op, ["Golf"])).not.toBeNull()
    }
    expect(optionConditionIssue("select", "contains", ["Gold"])).not.toBeNull()
  })

  test("refuses the wrong value shape", () => {
    expect(optionConditionIssue("select", "eq", ["Gold"])).not.toBeNull()
    expect(optionConditionIssue("select", "eq", "  ")).not.toBeNull()
    expect(optionConditionIssue("select", "eq", null)).not.toBeNull()
    expect(optionConditionIssue("select", "in", "Gold")).not.toBeNull()
    expect(optionConditionIssue("multiSelect", "eq", "Golf")).not.toBeNull()
    expect(optionConditionIssue("multiSelect", "in", [])).not.toBeNull()
    expect(
      optionConditionIssue("multiSelect", "in", ["Golf", " "]),
    ).not.toBeNull()
    expect(
      optionConditionIssue("multiSelect", "in", ["Golf", 3]),
    ).not.toBeNull()
    expect(
      optionConditionIssue("multiSelect", "in", { 0: "Golf" }),
    ).not.toBeNull()
    const tooMany = Array.from(
      { length: MAX_CUSTOM_FIELD_OPTIONS + 1 },
      (_, i) => `o${i}`,
    )
    expect(optionConditionIssue("multiSelect", "in", tooMany)).not.toBeNull()
    expect(
      optionConditionIssue("multiSelect", "in", tooMany.slice(1)),
    ).toBeNull()
  })

  test("list-taking operators", () => {
    expect(optionOperatorTakesList("select", "eq")).toBe(false)
    expect(optionOperatorTakesList("select", "notIn")).toBe(true)
    expect(optionOperatorTakesList("multiSelect", "eq")).toBe(true)
    expect(optionOperatorTakesList("multiSelect", "isEmpty")).toBe(false)
  })
})

describe("matchesOptionCondition (s203)", () => {
  test("select", () => {
    expect(matchesOptionCondition("select", "eq", "Gold", "Gold")).toBe(true)
    expect(matchesOptionCondition("select", "eq", "gold", "Gold")).toBe(false)
    expect(
      matchesOptionCondition("select", "in", "Gold", ["Silver", "Gold"]),
    ).toBe(true)
    expect(matchesOptionCondition("select", "notIn", "Gold", ["Silver"])).toBe(
      true,
    )
    // no value: only the negatives match
    for (const stored of [null, undefined, ""]) {
      expect(matchesOptionCondition("select", "eq", stored, "Gold")).toBe(false)
      expect(matchesOptionCondition("select", "in", stored, ["Gold"])).toBe(
        false,
      )
      expect(matchesOptionCondition("select", "ne", stored, "Gold")).toBe(true)
      expect(matchesOptionCondition("select", "notIn", stored, ["Gold"])).toBe(
        true,
      )
      expect(
        matchesOptionCondition("select", "isEmpty", stored, undefined),
      ).toBe(true)
    }
  })

  test("multiSelect any / all / none / exact, with a comma option", () => {
    const m = (op: string, value: unknown, stored: string | null = STORED) =>
      matchesOptionCondition("multiSelect", op, stored, value)
    expect(m("in", ["Hiking", "Red, White"])).toBe(true)
    expect(m("in", ["Red"])).toBe(false)
    expect(m("contains", ["Golf", "Red, White"])).toBe(true)
    expect(m("contains", ["Golf", "Hiking"])).toBe(false)
    expect(m("notIn", ["Hiking"])).toBe(true)
    expect(m("notIn", ["Golf"])).toBe(false)
    expect(m("eq", ["Red, White", "Golf"])).toBe(true)
    expect(m("eq", ["Golf"])).toBe(false)
    expect(m("ne", ["Golf"])).toBe(true)
    expect(m("isNotEmpty", undefined)).toBe(true)
    expect(m("isEmpty", undefined, "[]")).toBe(true)
    expect(m("notIn", ["Golf"], null)).toBe(true)
    expect(m("in", ["Golf"], null)).toBe(false)
  })

  test("hostile stored values never throw", () => {
    const m = (stored: string, op: string, value: unknown) =>
      matchesOptionCondition("multiSelect", op, stored, value)
    expect(m("Golf", "in", ["Golf"])).toBe(true) // legacy text = one item
    expect(m("[Golf", "in", ["[Golf"])).toBe(true) // malformed JSON = one item
    expect(m('{"a":1}', "in", ["a"])).toBe(false)
    expect(m('["Golf",1]', "eq", ["Golf"])).toBe(false) // non-string never equals
    expect(m('["Golf",1]', "in", ["Golf"])).toBe(true)
    expect(m("   ", "isEmpty", undefined)).toBe(true)
  })

  test("unknown operator is false", () => {
    expect(
      matchesOptionCondition("multiSelect", "startsWith", STORED, ["G"]),
    ).toBe(false)
    expect(matchesOptionCondition("select", "gt", "Gold", "A")).toBe(false)
  })

  test("the table lists every operator the evaluator knows", () => {
    expect(OPTION_FIELD_OPERATORS.select).toHaveLength(6)
    expect(OPTION_FIELD_OPERATORS.multiSelect).toHaveLength(7)
  })
})
