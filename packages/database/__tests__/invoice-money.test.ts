import { describe, expect, test } from "vitest"
import {
  currencyExponent,
  DEFAULT_INVOICE_CURRENCY,
  decimalStringToMinor,
  INVOICE_STATUS_TRANSITIONS,
  type InvoiceStatus,
  invoiceStatuses,
  minorToDecimalString,
  normalizeInvoiceCurrency,
  parseMoneyToMinor,
  STRIPE_SECRET_KEY_PATTERN,
  STRIPE_WEBHOOK_SECRET_PATTERN,
} from "../src/partials/invoice"

/**
 * Hub invoice money helpers (s205b): exact parsing (no floating point), the
 * numeric(14,2) storage bound, zero-decimal currencies, and the status
 * transition table that keeps terminal states terminal.
 */

/** numeric(14,2): 12 integer digits + 2 decimals. */
const MAX_MINOR = 99_999_999_999_999n
const MAX_DECIMAL = "999999999999.99"

describe("parseMoneyToMinor (USD, two decimals)", () => {
  test.each([
    ["1,250.50", 125_050n],
    ["1,234,567.89", 123_456_789n],
    ["1250.5", 125_050n],
    ["1250.50", 125_050n],
    ["7", 700n],
    ["0", 0n],
    ["0.1", 10n],
    ["0.01", 1n],
    ["0.10", 10n],
    [" 12.50 ", 1250n],
    ["007.00", 700n],
    [MAX_DECIMAL, MAX_MINOR],
  ])("string %j -> %s", (input, expected) => {
    expect(parseMoneyToMinor(input, "USD")).toBe(expected)
  })

  test.each([
    [12.5, 1250n],
    [0.1, 10n],
    [7, 700n],
    [0, 0n],
    [-0, 0n],
    [19.99, 1999n],
    [123_456_789_012, 12_345_678_901_200n],
  ])("number %s -> %s", (input, expected) => {
    expect(parseMoneyToMinor(input, "USD")).toBe(expected)
  })

  test.each([
    ["-1", "negative string"],
    ["-0.01", "negative cents"],
    ["1.234", "three decimals"],
    ["1.", "trailing point"],
    [".5", "no integer part"],
    ["", "empty"],
    ["   ", "blank"],
    ["abc", "letters"],
    ["1e3", "exponent notation"],
    ["$5", "currency symbol"],
    ["1.2.3", "two points"],
    ["+5", "explicit plus"],
    ["1000000000000", "13 integer digits"],
    ["12,50", "decimal comma (would read as 1250)"],
    ["12,500", "ambiguous single thousands group"],
    ["1_000", "underscore separator"],
    ["1 000.25", "inner space"],
    ["12 50", "inner space between digit runs"],
    ["1,0", "decimal comma, one digit"],
    ["1,25,000", "non-thousands grouping"],
    [",100", "leading comma"],
    ["1,000,", "trailing comma"],
    ["1000000000000.00", "past numeric(14,2)"],
    ["NaN", "NaN text"],
    ["Infinity", "Infinity text"],
    ["0x10", "hex"],
  ])("string %j is rejected (%s)", (input) => {
    expect(parseMoneyToMinor(input, "USD")).toBeNull()
  })

  test.each([
    [-1, "negative"],
    [-0.01, "negative cents"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
    [Number.NEGATIVE_INFINITY, "-Infinity"],
    [1e21, "prints as 1e+21"],
    [1e-7, "prints as 1e-7"],
    [1.234, "three decimals"],
    [0.1 + 0.2, "binary float noise (0.30000000000000004)"],
    [1_000_000_000_000, "13 integer digits"],
  ])("number %s is rejected (%s)", (input) => {
    expect(parseMoneyToMinor(input, "USD")).toBeNull()
  })

  test.each([
    [null],
    [undefined],
    [true],
    [{}],
    [[]],
    [[5]],
    [10n],
  ])("non-string/number %s is rejected", (input) => {
    expect(parseMoneyToMinor(input, "USD")).toBeNull()
  })

  test("the currency code is case-insensitive for the exponent", () => {
    expect(parseMoneyToMinor("100.50", "usd")).toBe(10_050n)
    expect(parseMoneyToMinor("100.50", "jpy")).toBeNull()
  })
})

describe("parseMoneyToMinor (zero-decimal currencies)", () => {
  test.each([
    ["100", 100n],
    ["100.00", 100n],
    ["100.0", 100n],
    ["1,000,000", 1_000_000n],
    [100, 100n],
    ["999999999999", 999_999_999_999n],
  ])("JPY %j -> %s", (input, expected) => {
    expect(parseMoneyToMinor(input, "JPY")).toBe(expected)
  })

  test.each([
    ["100.50"],
    ["100.5"],
    ["0.01"],
    [100.5],
  ])("JPY fraction %j is rejected", (input) => {
    expect(parseMoneyToMinor(input, "JPY")).toBeNull()
  })

  test.each(["KRW", "VND", "CLP", "XOF"])("%s is zero-decimal", (code) => {
    expect(currencyExponent(code)).toBe(0)
    expect(parseMoneyToMinor("5", code)).toBe(5n)
    expect(parseMoneyToMinor("5.10", code)).toBeNull()
  })
})

describe("currencyExponent", () => {
  test("two-decimal by default, zero for Stripe's zero-decimal list", () => {
    expect(currencyExponent("USD")).toBe(2)
    expect(currencyExponent("EUR")).toBe(2)
    expect(currencyExponent(DEFAULT_INVOICE_CURRENCY)).toBe(2)
    expect(currencyExponent("JPY")).toBe(0)
    expect(currencyExponent("jpy")).toBe(0)
  })
})

describe("normalizeInvoiceCurrency", () => {
  test.each([
    ["usd", "USD"],
    ["USD", "USD"],
    [" eur ", "EUR"],
    ["Jpy", "JPY"],
  ])("%j -> %j", (input, expected) => {
    expect(normalizeInvoiceCurrency(input)).toBe(expected)
  })

  test.each([
    ["KWD", "three-decimal"],
    ["kwd", "three-decimal, lower-case"],
    ["BHD", "three-decimal"],
    ["JOD", "three-decimal"],
    ["OMR", "three-decimal"],
    ["TND", "three-decimal"],
    ["ISK", "Stripe special case (two-decimal amounts)"],
    ["UGX", "Stripe special case (two-decimal amounts)"],
    ["US", "two letters"],
    ["USDX", "four letters"],
    ["", "empty"],
    ["U$D", "symbol"],
    ["12A", "digits"],
  ])("%j is rejected (%s)", (input) => {
    expect(normalizeInvoiceCurrency(input)).toBeNull()
  })

  test.each([
    [null],
    [undefined],
    [840],
    [{}],
    [["USD"]],
  ])("non-string %j is rejected", (input) => {
    expect(normalizeInvoiceCurrency(input)).toBeNull()
  })
})

describe("minorToDecimalString / decimalStringToMinor", () => {
  test.each([
    [0n, "USD", "0.00"],
    [1n, "USD", "0.01"],
    [10n, "USD", "0.10"],
    [125_050n, "USD", "1250.50"],
    [MAX_MINOR, "USD", MAX_DECIMAL],
    [100n, "JPY", "100.00"],
    [0n, "JPY", "0.00"],
  ])("%s %s -> %j", (minor, currency, expected) => {
    expect(minorToDecimalString(minor, currency)).toBe(expected)
    expect(decimalStringToMinor(expected, currency)).toBe(minor)
  })

  test("a negative amount throws", () => {
    expect(() => minorToDecimalString(-1n, "USD")).toThrow(RangeError)
  })

  test("a string that is not a stored amount throws", () => {
    expect(() => decimalStringToMinor("abc", "USD")).toThrow(RangeError)
    expect(() => decimalStringToMinor("1.234", "USD")).toThrow(RangeError)
    expect(() => decimalStringToMinor("-1.00", "USD")).toThrow(RangeError)
    // A stored JPY amount always ends in .00; anything else is corruption.
    expect(() => decimalStringToMinor("100.50", "JPY")).toThrow(RangeError)
  })

  test("round trip: random minor units -> string -> minor (USD + JPY)", () => {
    const samples: bigint[] = [0n, 1n, 99n, 100n, 101n, MAX_MINOR]
    for (let i = 0; i < 500; i++) {
      // Two draws cover the full 14-digit range (a double holds ~15.9).
      const high = BigInt(Math.floor(Math.random() * 1_000_000_000))
      const low = BigInt(Math.floor(Math.random() * 100_000))
      samples.push((high * 100_000n + low) % (MAX_MINOR + 1n))
    }
    for (const minor of samples) {
      const usd = minorToDecimalString(minor, "USD")
      expect(decimalStringToMinor(usd, "USD")).toBe(minor)
      expect(parseMoneyToMinor(usd, "USD")).toBe(minor)
      const jpyMinor = minor % 1_000_000_000_000n
      const jpy = minorToDecimalString(jpyMinor, "JPY")
      expect(decimalStringToMinor(jpy, "JPY")).toBe(jpyMinor)
    }
  })
})

describe("INVOICE_STATUS_TRANSITIONS", () => {
  const TERMINAL: InvoiceStatus[] = ["paid", "void", "refunded"]

  test("covers every status and names only real statuses", () => {
    expect(Object.keys(INVOICE_STATUS_TRANSITIONS).sort()).toEqual(
      [...invoiceStatuses.options].sort(),
    )
    for (const from of Object.values(INVOICE_STATUS_TRANSITIONS)) {
      for (const status of from) {
        expect(invoiceStatuses.options).toContain(status)
      }
    }
  })

  test("paid / void / refunded never go back to open or draft", () => {
    for (const target of ["open", "draft"] as const) {
      for (const terminal of TERMINAL) {
        expect(INVOICE_STATUS_TRANSITIONS[target]).not.toContain(terminal)
      }
    }
  })

  test("void and refunded are dead ends; paid only moves to refunded", () => {
    for (const [target, from] of Object.entries(INVOICE_STATUS_TRANSITIONS)) {
      expect(from).not.toContain("void")
      expect(from).not.toContain("refunded")
      if (target !== "refunded") {
        expect(from).not.toContain("paid")
      }
    }
    expect(INVOICE_STATUS_TRANSITIONS.refunded).toEqual(["paid"])
  })

  test("nothing ever transitions INTO draft, and no self-loops", () => {
    expect(INVOICE_STATUS_TRANSITIONS.draft).toEqual([])
    for (const [target, from] of Object.entries(INVOICE_STATUS_TRANSITIONS)) {
      expect(from).not.toContain(target)
    }
  })
})

describe("Stripe key patterns", () => {
  const body = "a".repeat(24)

  test.each([
    `sk_test_${body}`,
    `sk_live_${body}`,
    `rk_test_${body}`,
    `rk_live_${body}`,
  ])("secret key %s is accepted", (key) => {
    expect(STRIPE_SECRET_KEY_PATTERN.test(key)).toBe(true)
  })

  test.each([
    [`pk_test_${body}`, "publishable key"],
    [`sk_prod_${body}`, "unknown mode"],
    [["sk", "test", "short"].join("_"), "under 16 chars"],
    [`sk_test_${"a".repeat(257)}`, "over 256 chars"],
    [`sk_test_${body} `, "trailing space"],
    [`sk_test_${body}\n`, "trailing newline"],
    [`sk_test_${body}-x`, "a dash"],
    [`whsec_${body}`, "a webhook secret"],
    ["", "empty"],
  ])("secret key %j is rejected (%s)", (key) => {
    expect(STRIPE_SECRET_KEY_PATTERN.test(key)).toBe(false)
  })

  test("webhook secret: whsec_ + 16..256 base64 chars", () => {
    expect(STRIPE_WEBHOOK_SECRET_PATTERN.test(`whsec_${body}`)).toBe(true)
    expect(
      STRIPE_WEBHOOK_SECRET_PATTERN.test("whsec_ab+/=cdefghijklmnop"),
    ).toBe(true)
    expect(STRIPE_WEBHOOK_SECRET_PATTERN.test("whsec_short")).toBe(false)
    expect(STRIPE_WEBHOOK_SECRET_PATTERN.test(`sk_test_${body}`)).toBe(false)
    expect(STRIPE_WEBHOOK_SECRET_PATTERN.test(`whsec_${body}!`)).toBe(false)
  })
})
