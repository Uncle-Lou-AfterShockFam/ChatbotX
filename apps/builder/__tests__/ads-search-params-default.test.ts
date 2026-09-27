import { describe, expect, test } from "vitest"
import { parseAdsAnalyticsSearchParams } from "@/features/ads/schema/analytics"

// 02:00 UTC on Sep 28 is still Sep 27 in New York.
const NOW = new Date("2026-09-28T02:00:00.000Z")

describe("parseAdsAnalyticsSearchParams (s214)", () => {
  test("a missing range defaults per call, not once at module load", async () => {
    const first = await parseAdsAnalyticsSearchParams({}, { now: NOW })
    const later = await parseAdsAnalyticsSearchParams(
      {},
      { now: new Date("2026-10-05T12:00:00.000Z") },
    )
    expect(first).toMatchObject({ from: "2026-09-22", to: "2026-09-28" })
    expect(later).toMatchObject({ from: "2026-09-29", to: "2026-10-05" })
  })

  test("the default is the viewer's days: the zone cookie when there is no tz param", async () => {
    const search = await parseAdsAnalyticsSearchParams(
      {},
      { now: NOW, requestTimeZone: "America/New_York" },
    )
    expect(search).toMatchObject({ from: "2026-09-21", to: "2026-09-27" })
  })

  test("the tz param wins over the zone cookie", async () => {
    const search = await parseAdsAnalyticsSearchParams(
      { tz: "Europe/Berlin" },
      { now: NOW, requestTimeZone: "America/New_York" },
    )
    expect(search).toMatchObject({ to: "2026-09-28", tz: "Europe/Berlin" })
  })

  test("an explicit range is kept as given", async () => {
    const search = await parseAdsAnalyticsSearchParams(
      { from: "2026-08-01", to: "2026-08-10" },
      { now: NOW, requestTimeZone: "America/New_York" },
    )
    expect(search).toMatchObject({ from: "2026-08-01", to: "2026-08-10" })
  })

  test("an invalid zone falls back to UTC days", async () => {
    const search = await parseAdsAnalyticsSearchParams(
      { tz: "Not/AZone" },
      { now: NOW },
    )
    expect(search).toMatchObject({ to: "2026-09-28" })
  })
})
