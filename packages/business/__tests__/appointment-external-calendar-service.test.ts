import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  buildContext: vi.fn(),
  parseAuth: vi.fn(),
  runAction: vi.fn(),
  disconnectProvider: vi.fn(),
}))

vi.mock("@chatbotx.io/integration-google-calendar", () => ({
  googleCalendarAuthSchema: {
    parse: (...args: unknown[]) => mocks.parseAuth(...args),
  },
  integration: {
    runAction: (...args: unknown[]) => mocks.runAction(...args),
    disconnect: (...args: unknown[]) => mocks.disconnectProvider(...args),
  },
}))

vi.mock("../src/integration-context", () => ({
  buildContext: (...args: unknown[]) => mocks.buildContext(...args),
}))

const { appointmentExternalCalendarService, normalizeBusyCalendarScope } =
  await import("../src/appointment-external-calendar/service")

describe("appointmentExternalCalendarService.getBusyIntervalsForAppointmentCalendar", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.parseAuth.mockImplementation((auth) => auth)
    mocks.buildContext.mockResolvedValue({ auth: { accessToken: "token-1" } })
    mocks.runAction.mockResolvedValue([
      {
        startAt: "2026-08-12T09:30:00.000Z",
        endAt: "2026-08-12T10:00:00.000Z",
      },
    ])
  })

  test("uses the provider calendar id from the Google connection", async () => {
    vi.spyOn(
      appointmentExternalCalendarService,
      "getGoogleConnectionForProviderCall",
    ).mockResolvedValue({
      id: "google-calendar-row-1",
      workspaceId: "workspace-1",
      integrationId: "integration-1",
      auth: { tokens: { accessToken: "token-1" } },
      providerCalendarId: "provider-calendar-1",
      email: "owner@example.test",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    } as never)

    const intervals =
      await appointmentExternalCalendarService.getBusyIntervalsForAppointmentCalendar(
        {
          workspaceId: "workspace-1",
          integrationId: "integration-1",
          timeMin: "2026-08-12T00:00:00.000Z",
          timeMax: "2026-08-12T23:59:59.999Z",
          timeZone: "UTC",
          timeoutMs: 2500,
        },
      )

    expect(mocks.runAction).toHaveBeenCalledWith("getBusyEvents", {
      ctx: { auth: { accessToken: "token-1" } },
      props: {
        calendarId: "provider-calendar-1",
        timeMin: "2026-08-12T00:00:00.000Z",
        timeMax: "2026-08-12T23:59:59.999Z",
        timeZone: "UTC",
        timeoutMs: 2500,
      },
    })
    expect(intervals).toEqual([
      {
        start: new Date("2026-08-12T09:30:00.000Z").getTime(),
        end: new Date("2026-08-12T10:00:00.000Z").getTime(),
      },
    ])
  })
})

describe("appointmentExternalCalendarService.getBusyIntervalsForAppointmentCalendar busy scope", () => {
  const connection = (busyCalendarScope: string) =>
    ({
      id: "google-calendar-row-1",
      workspaceId: "workspace-1",
      integrationId: "integration-1",
      auth: { tokens: { accessToken: "token-1" } },
      providerCalendarId: "provider-calendar-1",
      busyCalendarScope,
      email: "owner@example.test",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    }) as never
  const input = {
    workspaceId: "workspace-1",
    integrationId: "integration-1",
    timeMin: "2026-08-12T00:00:00.000Z",
    timeMax: "2026-08-12T23:59:59.999Z",
    timeZone: "UTC",
    timeoutMs: 2500,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.parseAuth.mockImplementation((auth) => auth)
    mocks.buildContext.mockResolvedValue({ auth: { accessToken: "token-1" } })
  })

  test("scope connected never lists calendars and passes no calendarIds", async () => {
    vi.spyOn(
      appointmentExternalCalendarService,
      "getGoogleConnectionForProviderCall",
    ).mockResolvedValue(connection("connected"))
    mocks.runAction.mockResolvedValue([])

    await appointmentExternalCalendarService.getBusyIntervalsForAppointmentCalendar(
      input,
    )

    expect(mocks.runAction).toHaveBeenCalledTimes(1)
    expect(mocks.runAction.mock.calls[0]?.[0]).toBe("getBusyEvents")
    expect(mocks.runAction.mock.calls[0]?.[1].props).not.toHaveProperty(
      "calendarIds",
    )
  })

  test("scope all lists the account's calendars and queries them with the connected id", async () => {
    vi.spyOn(
      appointmentExternalCalendarService,
      "getGoogleConnectionForProviderCall",
    ).mockResolvedValue(connection("all"))
    mocks.runAction.mockImplementation(async (action: string) =>
      action === "listCalendars"
        ? [
            {
              id: "provider-calendar-1",
              summary: "Me",
              primary: true,
              accessRole: "owner",
            },
            {
              id: "sober@group.calendar.google.com",
              summary: "Sober",
              primary: false,
              accessRole: "reader",
            },
          ]
        : [
            {
              startAt: "2026-08-12T11:00:00.000Z",
              endAt: "2026-08-12T12:00:00.000Z",
            },
          ],
    )

    const intervals =
      await appointmentExternalCalendarService.getBusyIntervalsForAppointmentCalendar(
        input,
      )

    expect(mocks.runAction).toHaveBeenCalledTimes(2)
    expect(mocks.runAction).toHaveBeenNthCalledWith(1, "listCalendars", {
      ctx: { auth: { accessToken: "token-1" } },
      props: { timeoutMs: 2500 },
    })
    expect(mocks.runAction).toHaveBeenNthCalledWith(2, "getBusyEvents", {
      ctx: { auth: { accessToken: "token-1" } },
      props: {
        calendarId: "provider-calendar-1",
        calendarIds: ["provider-calendar-1", "sober@group.calendar.google.com"],
        timeMin: input.timeMin,
        timeMax: input.timeMax,
        timeZone: "UTC",
        timeoutMs: 2500,
      },
    })
    expect(intervals).toEqual([
      {
        start: Date.parse("2026-08-12T11:00:00.000Z"),
        end: Date.parse("2026-08-12T12:00:00.000Z"),
      },
    ])
  })

  test("an unknown stored scope reads as connected (no listing)", async () => {
    vi.spyOn(
      appointmentExternalCalendarService,
      "getGoogleConnectionForProviderCall",
    ).mockResolvedValue(connection("everything"))
    mocks.runAction.mockResolvedValue([])

    await appointmentExternalCalendarService.getBusyIntervalsForAppointmentCalendar(
      input,
    )

    expect(mocks.runAction).toHaveBeenCalledTimes(1)
    expect(mocks.runAction.mock.calls[0]?.[0]).toBe("getBusyEvents")
  })

  test("a listing failure under scope all propagates (fail closed)", async () => {
    vi.spyOn(
      appointmentExternalCalendarService,
      "getGoogleConnectionForProviderCall",
    ).mockResolvedValue(connection("all"))
    mocks.runAction.mockRejectedValue(new Error("listing exploded"))

    await expect(
      appointmentExternalCalendarService.getBusyIntervalsForAppointmentCalendar(
        input,
      ),
    ).rejects.toThrow("listing exploded")
  })
})

describe("normalizeBusyCalendarScope", () => {
  test("only the literal all widens; null, blank and junk stay connected", () => {
    expect(normalizeBusyCalendarScope("all")).toBe("all")
    expect(normalizeBusyCalendarScope("connected")).toBe("connected")
    expect(normalizeBusyCalendarScope(null)).toBe("connected")
    expect(normalizeBusyCalendarScope(undefined)).toBe("connected")
    expect(normalizeBusyCalendarScope("ALL")).toBe("connected")
    expect(normalizeBusyCalendarScope("")).toBe("connected")
  })
})

describe("appointmentExternalCalendarService.disconnect", () => {
  const connection = {
    id: "google-calendar-row-1",
    workspaceId: "workspace-1",
    integrationId: "integration-1",
    auth: { tokens: { accessToken: "token-1" } },
    providerCalendarId: "provider-calendar-1",
    email: "owner@example.test",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.parseAuth.mockImplementation((auth) => auth)
    vi.spyOn(
      appointmentExternalCalendarService,
      "getDisconnectableGoogleConnection",
    ).mockResolvedValue(connection as never)
    vi.spyOn(
      appointmentExternalCalendarService,
      "deleteByIntegrationIds",
    ).mockResolvedValue([{ id: "integration-1" }] as never)
  })

  test("revokes the Google-side grant before deleting the local row", async () => {
    mocks.disconnectProvider.mockResolvedValueOnce(undefined)

    await appointmentExternalCalendarService.disconnect({
      workspaceId: "workspace-1",
      integrationId: "integration-1",
    })

    expect(mocks.disconnectProvider).toHaveBeenCalledWith(connection.auth)
    expect(
      appointmentExternalCalendarService.deleteByIntegrationIds,
    ).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      integrationIds: ["integration-1"],
    })
  })

  test("still deletes the local row when the provider revoke fails", async () => {
    mocks.disconnectProvider.mockRejectedValueOnce(new Error("provider outage"))

    await appointmentExternalCalendarService.disconnect({
      workspaceId: "workspace-1",
      integrationId: "integration-1",
    })

    expect(
      appointmentExternalCalendarService.deleteByIntegrationIds,
    ).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      integrationIds: ["integration-1"],
    })
  })
})
