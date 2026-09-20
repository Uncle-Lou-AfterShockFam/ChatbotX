import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock("../src/client", () => ({
  getCalendarClient: () => ({ freebusy: { query: mocks.query } }),
}))
vi.mock("../src/logger", () => ({
  googleCalendarLogger: { warn: mocks.warn, error: mocks.error },
}))

const {
  chunkCalendarIds,
  FREE_BUSY_MAX_ITEMS,
  getBusyEvents,
  resolveBusyCalendarIds,
} = await import("../src/apis/busy-events")

const auth = { tokens: { accessToken: "t" } } as never
const window = {
  timeMin: "2026-09-21T00:00:00.000Z",
  timeMax: "2026-09-22T00:00:00.000Z",
}
const busy = (start: string, end: string) => ({ start, end })

describe("resolveBusyCalendarIds", () => {
  test("connected id first, extras de-duplicated and trimmed, blanks dropped", () => {
    expect(
      resolveBusyCalendarIds({
        calendarId: "primary",
        calendarIds: [
          " primary ",
          "b@group.calendar.google.com",
          "",
          "b@group.calendar.google.com",
        ],
      }),
    ).toEqual(["primary", "b@group.calendar.google.com"])
  })

  test("no ids at all resolves to an empty list", () => {
    expect(resolveBusyCalendarIds({})).toEqual([])
    expect(resolveBusyCalendarIds({ calendarId: "  " })).toEqual([])
  })
})

describe("chunkCalendarIds", () => {
  test("splits at Google's 50-item cap", () => {
    const ids = Array.from({ length: 51 }, (_, i) => `c${i}`)
    const chunks = chunkCalendarIds(ids)
    expect(FREE_BUSY_MAX_ITEMS).toBe(50)
    expect(chunks.map((c) => c.length)).toEqual([50, 1])
    expect(chunkCalendarIds([])).toEqual([])
  })
})

describe("getBusyEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test("single calendar: unchanged request shape and result", async () => {
    mocks.query.mockResolvedValue({
      data: {
        calendars: {
          primary: {
            busy: [busy("2026-09-21T14:00:00Z", "2026-09-21T14:30:00Z")],
          },
        },
      },
    })
    const out = await getBusyEvents({
      auth,
      calendarId: "primary",
      ...window,
      timeZone: "UTC",
      timeoutMs: 2500,
    })
    expect(mocks.query).toHaveBeenCalledTimes(1)
    expect(mocks.query).toHaveBeenCalledWith(
      {
        requestBody: {
          ...window,
          timeZone: "UTC",
          items: [{ id: "primary" }],
        },
      },
      { timeout: 2500 },
    )
    expect(out).toEqual([
      { startAt: "2026-09-21T14:00:00Z", endAt: "2026-09-21T14:30:00Z" },
    ])
  })

  test("several calendars: one query, union of every calendar's busy, sorted", async () => {
    mocks.query.mockResolvedValue({
      data: {
        calendars: {
          primary: {
            busy: [busy("2026-09-21T14:00:00Z", "2026-09-21T14:30:00Z")],
          },
          "sober@group.calendar.google.com": {
            busy: [busy("2026-09-21T11:00:00Z", "2026-09-21T12:00:00Z")],
          },
          "empty@group.calendar.google.com": { busy: [] },
        },
      },
    })
    const out = await getBusyEvents({
      auth,
      calendarId: "primary",
      calendarIds: [
        "sober@group.calendar.google.com",
        "empty@group.calendar.google.com",
        "primary",
      ],
      ...window,
    })
    expect(mocks.query).toHaveBeenCalledTimes(1)
    expect(mocks.query.mock.calls[0]?.[0].requestBody.items).toEqual([
      { id: "primary" },
      { id: "sober@group.calendar.google.com" },
      { id: "empty@group.calendar.google.com" },
    ])
    expect(out.map((e) => e.startAt)).toEqual([
      "2026-09-21T11:00:00Z",
      "2026-09-21T14:00:00Z",
    ])
  })

  test("51 calendars: two queries, results merged across chunks", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `c${i}@x`)
    mocks.query.mockImplementation(async ({ requestBody }) => ({
      data: {
        calendars: Object.fromEntries(
          requestBody.items.map((item: { id: string }) => [
            item.id,
            {
              busy: [
                busy(
                  `2026-09-21T${item.id === "primary" ? "01" : "02"}:00:00Z`,
                  "2026-09-21T03:00:00Z",
                ),
              ],
            },
          ]),
        ),
      },
    }))
    const out = await getBusyEvents({
      auth,
      calendarId: "primary",
      calendarIds: ids,
      ...window,
    })
    expect(mocks.query).toHaveBeenCalledTimes(2)
    expect(mocks.query.mock.calls[0]?.[0].requestBody.items).toHaveLength(50)
    expect(mocks.query.mock.calls[1]?.[0].requestBody.items).toHaveLength(1)
    expect(out).toHaveLength(51)
    expect(out[0]?.startAt).toBe("2026-09-21T01:00:00Z")
  })

  test("one calendar errors: skipped with a warning, the rest still block", async () => {
    mocks.query.mockResolvedValue({
      data: {
        calendars: {
          primary: {
            busy: [busy("2026-09-21T14:00:00Z", "2026-09-21T14:30:00Z")],
          },
          "gone@group.calendar.google.com": {
            errors: [{ domain: "global", reason: "notFound" }],
          },
        },
      },
    })
    const out = await getBusyEvents({
      auth,
      calendarId: "primary",
      calendarIds: ["gone@group.calendar.google.com"],
      ...window,
    })
    expect(out).toHaveLength(1)
    expect(mocks.warn).toHaveBeenCalledTimes(1)
    expect(mocks.warn.mock.calls[0]?.[0]).toEqual({
      failed: [{ id: "gone@group.calendar.google.com", reason: "notFound" }],
      queried: 2,
    })
  })

  test("a calendar missing from the response counts as failed, not free", async () => {
    mocks.query.mockResolvedValue({
      data: { calendars: { primary: { busy: [] } } },
    })
    await getBusyEvents({
      auth,
      calendarId: "primary",
      calendarIds: ["missing@x"],
      ...window,
    })
    expect(mocks.warn.mock.calls[0]?.[0].failed).toEqual([
      { id: "missing@x", reason: "missing" },
    ])
  })

  test("every calendar errors: throws (fail closed) instead of reporting free", async () => {
    mocks.query.mockResolvedValue({
      data: {
        calendars: {
          primary: { errors: [{ reason: "notFound" }] },
          "b@x": { errors: [{ reason: "forbidden" }] },
        },
      },
    })
    await expect(
      getBusyEvents({
        auth,
        calendarId: "primary",
        calendarIds: ["b@x"],
        ...window,
      }),
    ).rejects.toThrow("free/busy failed for every calendar")
    expect(mocks.warn).not.toHaveBeenCalled()
  })

  test("no calendar id at all throws before any request", async () => {
    await expect(
      getBusyEvents({ auth, calendarId: " ", calendarIds: [""], ...window }),
    ).rejects.toThrow("no calendar id to query")
    expect(mocks.query).not.toHaveBeenCalled()
  })

  test("a transport error surfaces as an SdkException", async () => {
    mocks.query.mockRejectedValue(new Error("socket hang up"))
    await expect(
      getBusyEvents({ auth, calendarId: "primary", ...window }),
    ).rejects.toThrow("Google Calendar API error: socket hang up")
  })
})
