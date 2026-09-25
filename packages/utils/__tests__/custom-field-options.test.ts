import { describe, expect, test } from "vitest"
import {
  canonicalMultiSelectValue,
  canonicalSelectValue,
  customFieldOptionsIssue,
  customFieldTypes,
  formatMultiSelectText,
  isOptionFieldType,
  MAX_CUSTOM_FIELD_OPTIONS,
  multiSelectItems,
  splitMultiSelectInput,
} from "../src/custom-field"

const OPTIONS = ["Gold", "Silver", "Bronze", "Red, White"] as const
const NEEDS_RE = /needs/
const DUPLICATE_RE = /Duplicate/
const ONLY_RE = /Only/

describe("customFieldTypes (s201)", () => {
  test("includes the option types", () => {
    expect(customFieldTypes.options).toContain("select")
    expect(customFieldTypes.options).toContain("multiSelect")
    expect(isOptionFieldType("select")).toBe(true)
    expect(isOptionFieldType("multiSelect")).toBe(true)
    expect(isOptionFieldType("shortText")).toBe(false)
  })
})

describe("customFieldOptionsIssue", () => {
  test("an option type needs a valid list", () => {
    expect(customFieldOptionsIssue("select", ["A", "B"])).toBeNull()
    expect(customFieldOptionsIssue("select", undefined)).toMatch(NEEDS_RE)
    expect(customFieldOptionsIssue("select", null)).toMatch(NEEDS_RE)
    expect(customFieldOptionsIssue("multiSelect", [])).not.toBeNull()
    expect(customFieldOptionsIssue("select", ["A", " "])).not.toBeNull()
    expect(customFieldOptionsIssue("select", "A")).not.toBeNull()
    expect(customFieldOptionsIssue("select", [1, 2])).not.toBeNull()
    expect(customFieldOptionsIssue("select", ["A", "a"])).toMatch(DUPLICATE_RE)
    expect(customFieldOptionsIssue("select", ["x".repeat(61)])).not.toBeNull()
  })

  test("caps the list at MAX_CUSTOM_FIELD_OPTIONS", () => {
    const at = Array.from(
      { length: MAX_CUSTOM_FIELD_OPTIONS },
      (_, i) => `o${i}`,
    )
    expect(customFieldOptionsIssue("select", at)).toBeNull()
    expect(customFieldOptionsIssue("select", [...at, "extra"])).not.toBeNull()
  })

  test("any other type must not carry options", () => {
    expect(customFieldOptionsIssue("shortText", undefined)).toBeNull()
    expect(customFieldOptionsIssue("shortText", null)).toBeNull()
    expect(customFieldOptionsIssue("shortText", ["A"])).toMatch(ONLY_RE)
  })
})

describe("canonicalSelectValue", () => {
  test("known option -> canonical spelling; blank -> unset; unknown -> null", () => {
    expect(canonicalSelectValue("gold", OPTIONS)).toBe("Gold")
    expect(canonicalSelectValue("  Silver ", OPTIONS)).toBe("Silver")
    expect(canonicalSelectValue("red, white", OPTIONS)).toBe("Red, White")
    expect(canonicalSelectValue("   ", OPTIONS)).toBe("")
    expect(canonicalSelectValue("Platinum", OPTIONS)).toBeNull()
  })
})

describe("canonicalMultiSelectValue", () => {
  test("JSON array and comma list both canonicalise to option order", () => {
    expect(canonicalMultiSelectValue('["bronze","Gold"]', OPTIONS)).toEqual({
      ok: true,
      value: '["Gold","Bronze"]',
    })
    expect(canonicalMultiSelectValue("silver , gold, gold", OPTIONS)).toEqual({
      ok: true,
      value: '["Gold","Silver"]',
    })
  })

  test("an option containing a comma: whole-input match or JSON", () => {
    expect(canonicalMultiSelectValue("Red, White", OPTIONS)).toEqual({
      ok: true,
      value: '["Red, White"]',
    })
    expect(canonicalMultiSelectValue('["Red, White","Gold"]', OPTIONS)).toEqual(
      { ok: true, value: '["Gold","Red, White"]' },
    )
  })

  test("empty selection is unset", () => {
    expect(canonicalMultiSelectValue("", OPTIONS)).toEqual({
      ok: true,
      value: "",
    })
    expect(canonicalMultiSelectValue("[]", OPTIONS)).toEqual({
      ok: true,
      value: "",
    })
    expect(canonicalMultiSelectValue(" , ,", OPTIONS)).toEqual({
      ok: true,
      value: "",
    })
  })

  test("unknown items are reported, never dropped", () => {
    expect(canonicalMultiSelectValue("Gold, Platinum", OPTIONS)).toEqual({
      ok: false,
      reason: "unknownOption",
      unknown: ["Platinum"],
    })
  })

  test("a JSON array holding a non-string is malformed", () => {
    expect(canonicalMultiSelectValue('["Gold", 1]', OPTIONS)).toEqual({
      ok: false,
      reason: "malformed",
    })
    expect(canonicalMultiSelectValue('[{"a":1}]', OPTIONS)).toEqual({
      ok: false,
      reason: "malformed",
    })
  })

  test("more raw items than the option cap is refused", () => {
    const many = Array.from(
      { length: MAX_CUSTOM_FIELD_OPTIONS + 1 },
      () => "Gold",
    )
    expect(canonicalMultiSelectValue(JSON.stringify(many), OPTIONS)).toEqual({
      ok: false,
      reason: "tooManyItems",
    })
    expect(canonicalMultiSelectValue(many.join(","), OPTIONS)).toEqual({
      ok: false,
      reason: "tooManyItems",
    })
  })

  test("property: any shuffled/duplicated/padded subset is idempotent and ordered", () => {
    let seed = 20_260_925
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    const plain = ["Gold", "Silver", "Bronze"]
    for (let run = 0; run < 500; run++) {
      const items: string[] = []
      const n = Math.floor(rand() * 8)
      for (let i = 0; i < n; i++) {
        const o = plain[Math.floor(rand() * plain.length)] as string
        const cased = rand() < 0.5 ? o.toUpperCase() : o.toLowerCase()
        items.push(`${" ".repeat(Math.floor(rand() * 3))}${cased} `)
      }
      const raw = rand() < 0.5 ? JSON.stringify(items) : items.join(",")
      const first = canonicalMultiSelectValue(raw, OPTIONS)
      expect(first.ok).toBe(true)
      if (!first.ok) {
        continue
      }
      const expected = OPTIONS.filter((o) =>
        items.some((i) => i.trim().toLowerCase() === o.toLowerCase()),
      )
      expect(first.value).toBe(expected.length ? JSON.stringify(expected) : "")
      // Idempotent: re-canonicalising the stored text changes nothing.
      expect(canonicalMultiSelectValue(first.value, OPTIONS)).toEqual(first)
    }
  })
})

describe("stored multiSelect text", () => {
  test("items and display text", () => {
    expect(multiSelectItems('["Gold","Red, White"]')).toEqual([
      "Gold",
      "Red, White",
    ])
    expect(formatMultiSelectText('["Gold","Red, White"]')).toBe(
      "Gold, Red, White",
    )
    expect(multiSelectItems("")).toEqual([])
  })

  test("legacy / malformed text is shown as one item, never throws", () => {
    expect(multiSelectItems("Gold, Silver")).toEqual(["Gold, Silver"])
    expect(multiSelectItems("[not json")).toEqual(["[not json"])
    expect(multiSelectItems('{"a":1}')).toEqual(['{"a":1}'])
    expect(multiSelectItems("[1,2]")).toEqual([])
  })

  test("splitMultiSelectInput", () => {
    expect(splitMultiSelectInput("  ")).toEqual([])
    expect(splitMultiSelectInput("a,b")).toEqual(["a", "b"])
    expect(splitMultiSelectInput("[not json")).toEqual(["[not json"])
  })
})

describe("display text round-trips (s201 probe)", () => {
  test("a comma option inside a comma list is re-joined, longest first", () => {
    const opts = ["Red", "Red, White", "Blue"]
    expect(canonicalMultiSelectValue("Red, White, Blue", opts)).toEqual({
      ok: true,
      value: '["Red, White","Blue"]',
    })
    expect(canonicalMultiSelectValue("Blue, Red", opts)).toEqual({
      ok: true,
      value: '["Red","Blue"]',
    })
    const stored = '["Red, White","Blue"]'
    expect(
      canonicalMultiSelectValue(formatMultiSelectText(stored), opts),
    ).toEqual({ ok: true, value: stored })
  })
})
