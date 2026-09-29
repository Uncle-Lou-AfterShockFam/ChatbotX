import { describe, expect, test } from "vitest"
import {
  EMAIL_SUPPRESSION_MAX_LENGTH,
  emailSuppressionKeysFor,
  parseEmailSuppression,
} from "../src/partials/email-suppression"

describe("parseEmailSuppression (s224b): the closed entry parser", () => {
  test("an address and an @domain parse, trimmed and lower-cased", () => {
    expect(parseEmailSuppression("  Jane.Doe+x@Example.COM ")).toEqual({
      ok: true,
      kind: "address",
      value: "jane.doe+x@example.com",
    })
    expect(parseEmailSuppression("@AfterShockFam.org")).toEqual({
      ok: true,
      kind: "domain",
      value: "@aftershockfam.org",
    })
    expect(parseEmailSuppression("a@xn--bcher-kva.example").ok).toBe(true)
  })

  test("every refusal class names its reason", () => {
    const cases: [unknown, string][] = [
      [null, "not-a-string"],
      [undefined, "not-a-string"],
      [42, "not-a-string"],
      [{ value: "a@b.com" }, "not-a-string"],
      [["a@b.com"], "not-a-string"],
      ["", "empty"],
      ["   ", "empty"],
      [`${"a".repeat(EMAIL_SUPPRESSION_MAX_LENGTH)}@b.com`, "too-long"],
      ["jane doe@example.com", "whitespace"],
      ["jane@exa\tmple.com", "whitespace"],
      ["example.com", "no-at"],
      ["a@b@example.com", "multiple-at"],
      ["@@example.com", "multiple-at"],
      ["a@", "bad-domain"],
      ["@", "bad-domain"],
      ["a@localhost", "bad-domain"],
      ["a@example..com", "bad-domain"],
      ["a@.example.com", "bad-domain"],
      ["a@example.com.", "bad-domain"],
      ["a@-example.com", "bad-domain"],
      ["a@exa_mple.com", "bad-domain"],
      ["a@exämple.com", "bad-domain"],
      ["a@example.com/path", "bad-domain"],
      [`a@${"x".repeat(64)}.com`, "bad-domain"],
    ]
    for (const [input, reason] of cases) {
      expect(parseEmailSuppression(input), String(input)).toEqual({
        ok: false,
        reason,
      })
    }
  })

  test("fuzz: random input never throws, and anything accepted re-parses to itself", () => {
    const alphabet = "aZ09.-_@+ \t<>,;:é\u0000/"
    let seed = 224
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed
    }
    for (let i = 0; i < 5000; i++) {
      const length = next() % 40
      let input = ""
      for (let j = 0; j < length; j++) {
        input += alphabet[next() % alphabet.length]
      }
      const parsed = parseEmailSuppression(input)
      if (parsed.ok) {
        expect(parseEmailSuppression(parsed.value)).toEqual(parsed)
        expect(parsed.value).toBe(parsed.value.toLowerCase())
        expect(parsed.value.split("@")).toHaveLength(2)
      }
    }
  })
})

describe("emailSuppressionKeysFor (s224b)", () => {
  test("an address yields itself and its exact @domain", () => {
    expect(emailSuppressionKeysFor("Jane@Mail.Example.com")).toEqual([
      "jane@mail.example.com",
      "@mail.example.com",
    ])
  })

  test("a domain entry, junk or a non-string yields null (callers fail closed)", () => {
    for (const input of ["@example.com", "nope", "", null, 3, "a@b@c.com"]) {
      expect(emailSuppressionKeysFor(input)).toBeNull()
    }
  })
})
