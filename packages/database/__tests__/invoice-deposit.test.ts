import { describe, expect, test } from "vitest"
import {
  INVOICE_STATUS_TRANSITIONS,
  invoiceDocumentKind,
  resolveDepositMinor,
} from "../src/partials/invoice"

/** s216b: what a deposit resolves to, and the partly paid state it creates. */
describe("resolveDepositMinor", () => {
  const usd = (type: "amount" | "percent", value: unknown, total = 20_000n) =>
    resolveDepositMinor({ type, value, totalMinor: total, currency: "USD" })

  test.each([
    ["25", 5000n],
    ["12.5", 2500n],
    ["33.33", 6666n],
    ["0.01", 2n],
    ["99.99", 19_998n],
    [25, 5000n],
  ])("percent %s of $200.00 = %s cents", (value, expected) => {
    expect(usd("percent", value)).toBe(expected)
  })

  test("a percent rounds half-up to the cent", () => {
    // 33.335% of $1.00 = 33.335 cents -> 33; 50% of $0.03 = 1.5 -> 2
    expect(usd("percent", "33.33", 100n)).toBe(33n)
    expect(usd("percent", "50", 3n)).toBe(2n)
  })

  test.each([
    ["50", 5000n],
    ["50.00", 5000n],
    ["199.99", 19_999n],
    ["1,50.00", null],
  ])("amount %s = %s cents", (value, expected) => {
    expect(usd("amount", value)).toBe(expected)
  })

  test.each([
    ["percent", "0"],
    ["percent", "100"],
    ["percent", "150"],
    ["percent", "-5"],
    ["percent", "25.555"],
    ["percent", "abc"],
    ["percent", ""],
    ["amount", "0"],
    ["amount", "200.00"],
    ["amount", "250"],
    ["amount", "-1"],
    ["amount", "12,50"],
    ["amount", null],
    ["amount", { value: 5 }],
  ] as const)("%s %j is refused (not above zero and below the total)", (type, value) => {
    expect(usd(type, value)).toBeNull()
  })

  test("a percent that rounds to zero is refused", () => {
    expect(usd("percent", "0.01", 10n)).toBeNull()
  })

  test("zero-decimal currencies: whole yen, no fraction", () => {
    const jpy = (type: "amount" | "percent", value: string) =>
      resolveDepositMinor({ type, value, totalMinor: 1000n, currency: "JPY" })
    expect(jpy("amount", "250")).toBe(250n)
    expect(jpy("amount", "250.50")).toBeNull()
    expect(jpy("percent", "33.33")).toBe(333n)
  })

  test("property: every accepted deposit is strictly between 0 and the total", () => {
    for (let total = 1n; total <= 400n; total += 7n) {
      for (let hundredths = 1; hundredths < 10_000; hundredths += 97) {
        const value = (hundredths / 100).toFixed(2)
        const minor = resolveDepositMinor({
          type: "percent",
          value,
          totalMinor: total,
          currency: "USD",
        })
        if (minor !== null) {
          expect(minor > 0n && minor < total).toBe(true)
        }
      }
    }
  })
})

describe("partiallyPaid", () => {
  test("it comes from open only; paid comes from it; void never does", () => {
    expect(INVOICE_STATUS_TRANSITIONS.partiallyPaid).toEqual(["open"])
    expect(INVOICE_STATUS_TRANSITIONS.paid).toContain("partiallyPaid")
    expect(INVOICE_STATUS_TRANSITIONS.void).not.toContain("partiallyPaid")
    expect(INVOICE_STATUS_TRANSITIONS.refunded).not.toContain("partiallyPaid")
  })

  test("its document is the deposit receipt", () => {
    expect(invoiceDocumentKind("partiallyPaid")).toBe("depositReceipt")
    expect(invoiceDocumentKind("open")).toBe("invoice")
    expect(invoiceDocumentKind("paid")).toBe("receipt")
  })
})
