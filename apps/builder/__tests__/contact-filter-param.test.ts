// @vitest-environment node
import { describe, expect, test } from "vitest"
import {
  contactFilterCriteriaSchema,
  parseContactFilterParam,
} from "@/features/contact-filter/schema"

const VALID = {
  operator: "and",
  conditions: [{ field: "fullName", operator: "isNotEmpty" }],
}

describe("parseContactFilterParam (s206: an invalid filter never widens)", () => {
  test.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
    ["a blank string", "  \t "],
  ])("%s is absent", (_label, value) => {
    expect(parseContactFilterParam(value)).toEqual({ status: "absent" })
  })

  test("a valid JSON filter parses", () => {
    expect(parseContactFilterParam(JSON.stringify(VALID))).toEqual({
      status: "valid",
      filter: VALID,
    })
  })

  test("an empty conditions list is valid (the operator's 'everyone')", () => {
    expect(
      parseContactFilterParam(
        JSON.stringify({ operator: "and", conditions: [] }),
      ).status,
    ).toBe("valid")
  })

  test.each([
    ["malformed JSON", "{bad"],
    ["JSON null", "null"],
    ["a JSON array", "[]"],
    ["a JSON number", "42"],
    ["a bad operator", JSON.stringify({ operator: "xor", conditions: [] })],
    [
      "an unknown field",
      JSON.stringify({ operator: "and", conditions: [{ field: "nope" }] }),
    ],
    [
      "a repeated param (array)",
      [JSON.stringify(VALID), JSON.stringify(VALID)],
    ],
    ["a number", 7],
    ["an object", VALID],
  ])("%s is invalid", (_label, value) => {
    expect(parseContactFilterParam(value)).toEqual({ status: "invalid" })
  })

  // Property: for any non-blank string the verdict is never "absent", and a
  // "valid" verdict always carries a filter the strict schema accepts.
  test("fuzz: non-blank input is never absent; valid always re-validates", () => {
    let seed = 206
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    const alphabet = [
      "{",
      "}",
      "[",
      "]",
      '"',
      ":",
      ",",
      "operator",
      "conditions",
      "and",
      "or",
      "field",
      "fullName",
      "isNotEmpty",
      "null",
      "1",
      " ",
      "\\",
      "é",
    ]
    const seeds = [
      JSON.stringify(VALID),
      JSON.stringify({ operator: "or", conditions: [] }),
    ]
    for (let i = 0; i < 2000; i++) {
      let value: string
      if (i % 4 === 0) {
        // Mutate a valid filter: drop, duplicate or swap one character.
        const base = seeds[i % seeds.length] ?? ""
        const at = Math.floor(next() * base.length)
        value = base.slice(0, at) + base.slice(at + 1)
      } else {
        const length = 1 + Math.floor(next() * 12)
        value = Array.from(
          { length },
          () => alphabet[Math.floor(next() * alphabet.length)],
        ).join("")
      }
      const result = parseContactFilterParam(value)
      if (value.trim() !== "") {
        expect(result.status).not.toBe("absent")
      }
      if (result.status === "valid") {
        expect(
          contactFilterCriteriaSchema.safeParse(result.filter).success,
        ).toBe(true)
      }
    }
  })
})
