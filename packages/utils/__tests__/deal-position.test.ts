import { describe, expect, test } from "vitest"
import { DEAL_POSITION_STEP, positionBetween } from "../src/deal-position"

describe("positionBetween (shared by the deal service and the board)", () => {
  test.each([
    [null, null, 1000],
    [undefined, undefined, 1000],
    [null, 1000, 0],
    [1000, null, 2000],
    [1000, 2000, 1500],
    [-500, 500, 0],
  ])("between %s and %s -> %s", (before, after, expected) => {
    expect(positionBetween(before, after)).toBe(expected)
  })

  test("a custom step scales the open-ended cases", () => {
    expect(positionBetween(null, null, 10)).toBe(10)
    expect(positionBetween(5, null, 10)).toBe(15)
    expect(DEAL_POSITION_STEP).toBe(1000)
  })

  test.each([
    [Number.NaN, 1000, 0, "NaN before counts as absent"],
    [1000, Number.POSITIVE_INFINITY, 2000, "Infinity after counts as absent"],
    [Number.NaN, Number.NaN, 1000, "both non-finite -> step"],
  ])("%s / %s -> %s (%s)", (before, after, expected) => {
    expect(positionBetween(before, after)).toBe(expected)
  })

  test("the midpoint is always strictly between finite neighbours", () => {
    for (let i = 0; i < 200; i++) {
      const a = Math.random() * 1e6 - 5e5
      const b = a + Math.random() * 1e3 + 1e-3
      const mid = positionBetween(a, b)
      expect(mid).toBeGreaterThan(a)
      expect(mid).toBeLessThan(b)
    }
  })
})
