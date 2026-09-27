import { describe, expect, test } from "vitest"
import {
  formatDateWithYear,
  formatShortDate,
  formatTimeRangeDateWithYear,
} from "../src/utils/date-format"

// s212: an instant is printed in the zone the caller names (the viewer's),
// whatever zone the process runs in; a day key stays its own day.
describe("date-format timeZone (s212)", () => {
  const instant = new Date("2026-09-20T02:00:00.000Z") // Sep 19, 22:00 in New York

  test("an instant follows the named zone", () => {
    expect(formatDateWithYear(instant, "en-US", "America/New_York")).toBe(
      "Sep 19, 2026",
    )
    expect(formatDateWithYear(instant, "en-US", "UTC")).toBe("Sep 20, 2026")
    expect(formatShortDate(instant, "en-US", "UTC")).toBe("Sep 20")
    expect(
      formatTimeRangeDateWithYear(
        instant,
        "2026-01-01",
        "2026-12-31",
        "en-US",
        "America/New_York",
      ),
    ).toBe("Sep 2026")
  })

  test("a day key is its own day with no zone named", () => {
    expect(formatDateWithYear("2026-09-20", "en-US")).toBe("Sep 20, 2026")
  })
})
