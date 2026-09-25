import { describe, expect, test } from "vitest"
import { formatDate } from "../format"

describe("formatDate", () => {
  test("returns an empty string for a falsy date", () => {
    expect(formatDate(undefined)).toBe("")
  })

  test("formats using the default en-US locale when none is provided", () => {
    expect(formatDate(new Date(2026, 0, 15))).toBe("January 15, 2026")
  })

  test("formats using the given locale", () => {
    expect(formatDate(new Date(2026, 0, 15), { locale: "de" })).toContain(
      "Januar",
    )
  })

  test("merges custom Intl.DateTimeFormatOptions with the locale", () => {
    expect(
      formatDate(new Date(2026, 0, 15), { month: "short", locale: "de" }),
    ).toBe("15. Jan. 2026")
  })

  test("an explicit timeZone pins the day, whatever the process zone (s201c #418)", () => {
    // 02:00 UTC is still the previous evening in New York: without a zone the
    // UTC server and an EDT browser print different days and React 418s.
    const instant = "2026-09-25T02:00:00.000Z"
    expect(formatDate(instant, { timeZone: "UTC" })).toBe("September 25, 2026")
    expect(formatDate(instant, { timeZone: "America/New_York" })).toBe(
      "September 24, 2026",
    )
  })

  test("returns an empty string when the date cannot be parsed", () => {
    expect(formatDate("not-a-date")).toBe("")
  })
})
