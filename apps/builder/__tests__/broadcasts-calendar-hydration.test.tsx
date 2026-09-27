import type { BroadcastCalendarRow } from "@chatbotx.io/business"
import { act } from "react"
import { hydrateRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { CalendarRange } from "@/features/broadcasts/lib/calendar-grid"

// s210 live #418 on /broadcasts?view=calendar: the grid days are wall-clock
// Dates (local midnight of the PROCESS zone), but the labels were formatted in
// the VIEWER's zone. The server process runs UTC, so a New York viewer got
// "Sun" over Monday's column in the SSR html and "Mon" after hydration (the
// browser's process zone IS the viewer zone).
//
// Vitest cannot switch the process zone mid-run (process.env.TZ is ignored in
// the worker), so the server side is modelled by its defining property: a
// formatter zone WEST of the process zone. The client side formats in the
// process zone. The server zone is a fixed offset 6 h west of the process
// zone (clamped at UTC-12) and "now" is local noon, so both sides agree on
// today's date whatever zone the runner is in.
const PROCESS_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
const REQUEST_NOW = new Date(2026, 8, 26, 12)
const processOffsetHours = -REQUEST_NOW.getTimezoneOffset() / 60
// Etc/GMT signs are inverted: Etc/GMT+10 is UTC-10.
const etcHours = Math.min(12, Math.ceil(6 - processOffsetHours))
const SERVER_VIEWER_ZONE =
  etcHours >= 0 ? `Etc/GMT+${etcHours}` : `Etc/GMT${etcHours}`
const zone = vi.hoisted(() => ({ current: "UTC" }))

vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>()
  return {
    ...actual,
    useTranslations: () => (key: string) => key,
    useNow: () => REQUEST_NOW,
    useTimeZone: () => zone.current,
    // The real formatter, bound to the viewer zone like the provider does.
    useFormatter: () =>
      actual.createFormatter({
        locale: "en-US",
        now: REQUEST_NOW,
        timeZone: zone.current,
      }),
  }
})

vi.mock("nuqs", () => ({
  useQueryStates: () => [{}, vi.fn()],
}))

vi.mock("@/features/broadcasts/broadcast-detail-dialog", () => ({
  BroadcastDetailDialog: () => null,
}))

const { BroadcastsCalendar } = await import(
  "@/features/broadcasts/components/broadcasts-calendar"
)

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  container?.remove()
  container = undefined
})

function renderThenHydrate(range: CalendarRange, date: string, endDate = date) {
  const element = (
    <BroadcastsCalendar
      broadcasts={[]}
      date={date}
      endDate={endDate}
      range={range}
    />
  )
  zone.current = SERVER_VIEWER_ZONE
  const html = renderToString(element)
  zone.current = PROCESS_ZONE
  container = document.createElement("div")
  container.innerHTML = html
  document.body.appendChild(container)
  const recoverable = vi.fn()
  act(() => {
    root = hydrateRoot(container as HTMLElement, element, {
      onRecoverableError: recoverable,
    })
  })
  return { html, recoverable }
}

describe("broadcasts calendar hydrates across server and viewer zones", () => {
  test("the server zone is west of the process zone and shares today (guards the harness)", () => {
    const inZone = (timeZone: string, date: Date) =>
      new Intl.DateTimeFormat("en-US", {
        day: "numeric",
        timeZone,
        weekday: "short",
      }).format(date)
    expect(inZone(SERVER_VIEWER_ZONE, new Date(2026, 8, 28))).toBe("27 Sun")
    expect(inZone(SERVER_VIEWER_ZONE, REQUEST_NOW)).toBe(
      inZone(PROCESS_ZONE, REQUEST_NOW),
    )
  })

  test("month: the weekday header starts on Mon in the SSR html", () => {
    const { html, recoverable } = renderThenHydrate("month", "2026-09-26")
    expect(html.indexOf(">Mon<")).toBeGreaterThan(-1)
    expect(html.indexOf(">Mon<")).toBeLessThan(html.indexOf(">Sun<"))
    expect(recoverable).not.toHaveBeenCalled()
  })

  test.each([
    ["month", "2026-09-01", "2026-09-01", "September 2026"],
    ["week", "2026-09-28", "2026-09-28", "Sep 28"],
    ["day", "2026-09-28", "2026-09-28", "Monday, September 28, 2026"],
    ["custom", "2026-09-28", "2026-09-30", "Sep 28"],
  ] as const)("%s view on %s hydrates with no mismatch", (range, date, end, label) => {
    const { html, recoverable } = renderThenHydrate(range, date, end)
    expect(html).toContain(label)
    expect(recoverable).not.toHaveBeenCalled()
  })

  test("custom view: a day's agenda label is its wall-clock date in the SSR html", () => {
    // Local noon stays on the same date in the server zone (6 h west), so the
    // row groups under Sep 29 on both sides; only the label could drift.
    const row = {
      id: "b-1",
      name: "Broadcast b-1",
      schedulesAt: new Date(2026, 8, 29, 12),
      status: "scheduled",
    } as unknown as BroadcastCalendarRow
    zone.current = SERVER_VIEWER_ZONE
    const html = renderToString(
      <BroadcastsCalendar
        broadcasts={[row]}
        date="2026-09-28"
        endDate="2026-09-30"
        range="custom"
      />,
    )
    expect(html).toContain("Tue, Sep 29")
  })
})
