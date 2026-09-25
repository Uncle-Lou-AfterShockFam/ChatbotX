// @vitest-environment node

import { describe, expect, test } from "vitest"
import {
  chipTone,
  droppedDates,
  gridRange,
  groupByDueDay,
  isSameUtcMonth,
  monthGrid,
  startOfWeekDay,
  stepAnchor,
  weekGrid,
} from "../src/features/deal-tasks/lib/task-calendar-grid"
import {
  dayToDate,
  utcDay,
} from "../src/features/deal-tasks/lib/timeline-layout"
import { listTasksInRangeQuery } from "../src/features/deal-tasks/schema/action"

const D = (iso: string) => new Date(`${iso}T00:00:00Z`)
const iso = (day: number) => dayToDate(day).toISOString().slice(0, 10)

describe("s197 task calendar grid (UTC days, Monday first)", () => {
  test("October 2026 = 5 whole weeks from Mon Sep 28 to Sun Nov 1", () => {
    const grid = monthGrid(utcDay(D("2026-10-15")))
    expect(grid).toHaveLength(5)
    expect(grid.every((w) => w.length === 7)).toBe(true)
    expect(iso(grid[0][0])).toBe("2026-09-28")
    expect(iso(grid[4][6])).toBe("2026-11-01")
    expect(gridRange(grid)).toEqual({
      from: D("2026-09-28"),
      to: D("2026-11-02"),
    })
    // at most 42 days: always inside the server's 62-day cap
    expect(
      (gridRange(grid).to.getTime() - gridRange(grid).from.getTime()) /
        86_400_000,
    ).toBeLessThanOrEqual(42)
  })

  test("a month that starts on Monday has no leading days; a 6-week month exists", () => {
    // June 2026 starts on a Monday
    expect(iso(monthGrid(utcDay(D("2026-06-10")))[0][0])).toBe("2026-06-01")
    // August 2026: Sat 1st .. Mon 31st -> 6 rows
    expect(monthGrid(utcDay(D("2026-08-10")))).toHaveLength(6)
  })

  test("week grid + stepping: a Sunday belongs to the week that started the Monday before; month steps land on the 1st", () => {
    const sunday = utcDay(D("2026-10-04"))
    expect(iso(startOfWeekDay(sunday))).toBe("2026-09-28")
    expect(weekGrid(sunday)[0].map(iso)).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ])
    expect(iso(stepAnchor("week", sunday, 1))).toBe("2026-10-11")
    expect(iso(stepAnchor("month", utcDay(D("2026-01-31")), 1))).toBe(
      "2026-02-01",
    )
    expect(iso(stepAnchor("month", utcDay(D("2026-01-15")), -1))).toBe(
      "2025-12-01",
    )
    expect(
      isSameUtcMonth(utcDay(D("2026-10-01")), utcDay(D("2026-10-31"))),
    ).toBe(true)
    expect(
      isSameUtcMonth(utcDay(D("2026-10-31")), utcDay(D("2026-11-01"))),
    ).toBe(false)
  })

  test("grouping by UTC due day (a late-evening UTC time stays on its day); undated tasks are dropped", () => {
    const grouped = groupByDueDay([
      { id: "a", dueAt: new Date("2026-10-02T23:59:00Z") },
      { id: "b", dueAt: "2026-10-02T00:00:00Z" },
      { id: "c", dueAt: null },
    ])
    expect(grouped.get(utcDay(D("2026-10-02")))?.map((r) => r.id)).toEqual([
      "a",
      "b",
    ])
    expect([...grouped.values()].flat()).toHaveLength(2)
  })

  test("tone: done beats overdue; overdue = open and due before today", () => {
    const today = utcDay(D("2026-10-05"))
    expect(chipTone({ status: "done", dueAt: D("2026-10-01") }, today)).toBe(
      "done",
    )
    expect(chipTone({ status: "open", dueAt: D("2026-10-04") }, today)).toBe(
      "overdue",
    )
    expect(chipTone({ status: "open", dueAt: D("2026-10-05") }, today)).toBe(
      "open",
    )
  })

  test("a drop moves the due date to the day and an explicit start by the same delta; same day / undated = nothing", () => {
    expect(
      droppedDates(
        { startAt: D("2026-10-01"), dueAt: D("2026-10-03") },
        utcDay(D("2026-10-06")),
      ),
    ).toEqual({ startAt: D("2026-10-04"), dueAt: D("2026-10-06") })
    expect(
      droppedDates(
        { startAt: null, dueAt: D("2026-10-03") },
        utcDay(D("2026-10-01")),
      ),
    ).toEqual({ dueAt: D("2026-10-01") })
    expect(
      droppedDates(
        { startAt: null, dueAt: D("2026-10-03") },
        utcDay(D("2026-10-03")),
      ),
    ).toBeNull()
    expect(droppedDates({ startAt: null, dueAt: null }, 0)).toBeNull()
    // a template task: start and due on one day, start later than 00:00 -
    // the drop keeps both times, so the start never passes the due date
    expect(
      droppedDates(
        {
          startAt: new Date("2026-10-02T15:00:00Z"),
          dueAt: new Date("2026-10-02T15:00:00Z"),
        },
        utcDay(D("2026-10-05")),
      ),
    ).toEqual({
      startAt: new Date("2026-10-05T15:00:00Z"),
      dueAt: new Date("2026-10-05T15:00:00Z"),
    })
  })

  test("the range query coerces dates and refuses an unknown assignee value", () => {
    expect(
      listTasksInRangeQuery.parse({
        from: "2026-09-28T00:00:00Z",
        to: "2026-11-02T00:00:00Z",
        assignee: "me",
      }),
    ).toMatchObject({ from: D("2026-09-28"), assignee: "me" })
    expect(() =>
      listTasksInRangeQuery.parse({ from: "x", to: "2026-11-02" }),
    ).toThrow()
    expect(() =>
      listTasksInRangeQuery.parse({
        from: "2026-09-28",
        to: "2026-11-02",
        assignee: "team",
      }),
    ).toThrow()
  })
})
