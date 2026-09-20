import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
}))

vi.mock("../src/client", () => ({
  getCalendarClient: () => ({ calendarList: { list: mocks.list } }),
}))
vi.mock("../src/logger", () => ({
  googleCalendarLogger: { warn: vi.fn(), error: vi.fn() },
}))

const { CALENDAR_LIST_MAX, listCalendars } = await import(
  "../src/apis/list-calendars"
)

const auth = { tokens: { accessToken: "t" } } as never

describe("listCalendars", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test("follows pageToken, keeps readable calendars, drops deleted and write-less roles", async () => {
    mocks.list
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              id: "primary-id@gmail.com",
              summary: "Louis",
              primary: true,
              accessRole: "owner",
            },
            { id: "deleted@x", deleted: true, accessRole: "owner" },
            {
              id: "sober@group.calendar.google.com",
              summary: "Sober",
              accessRole: "reader",
            },
          ],
          nextPageToken: "p2",
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              id: "fb@x",
              summary: "Free/busy only",
              accessRole: "freeBusyReader",
            },
            { id: "none@x", summary: "No role", accessRole: "none" },
            { summary: "no id" },
          ],
        },
      })
    const out = await listCalendars({ auth, timeoutMs: 2500 })
    expect(mocks.list).toHaveBeenCalledTimes(2)
    expect(mocks.list.mock.calls[0]?.[0]).toEqual({
      maxResults: CALENDAR_LIST_MAX,
      minAccessRole: "freeBusyReader",
      pageToken: undefined,
    })
    expect(mocks.list.mock.calls[0]?.[1]).toEqual({ timeout: 2500 })
    expect(mocks.list.mock.calls[1]?.[0].pageToken).toBe("p2")
    expect(out).toEqual([
      {
        id: "primary-id@gmail.com",
        summary: "Louis",
        primary: true,
        accessRole: "owner",
      },
      {
        id: "sober@group.calendar.google.com",
        summary: "Sober",
        primary: false,
        accessRole: "reader",
      },
      {
        id: "fb@x",
        summary: "Free/busy only",
        primary: false,
        accessRole: "freeBusyReader",
      },
    ])
  })

  test("stops at the cap even when Google keeps paging", async () => {
    mocks.list.mockResolvedValue({
      data: {
        items: Array.from({ length: 200 }, (_, i) => ({
          id: `c${i}@x`,
          accessRole: "owner",
        })),
        nextPageToken: "more",
      },
    })
    const out = await listCalendars({ auth })
    expect(out).toHaveLength(CALENDAR_LIST_MAX)
    expect(mocks.list).toHaveBeenCalledTimes(2)
  })

  test("an empty account lists nothing and makes one request", async () => {
    mocks.list.mockResolvedValue({ data: {} })
    expect(await listCalendars({ auth })).toEqual([])
    expect(mocks.list).toHaveBeenCalledTimes(1)
  })

  test("a transport error surfaces as an SdkException", async () => {
    mocks.list.mockRejectedValue(new Error("boom"))
    await expect(listCalendars({ auth })).rejects.toThrow(
      "Google Calendar API error: boom",
    )
  })
})
