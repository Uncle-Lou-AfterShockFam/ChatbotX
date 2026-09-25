// @vitest-environment node

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  arrowPath,
  DAY_MS,
  draggedDates,
  layoutTimeline,
  localToday,
  moveToDay,
  openSuccessors,
  type TimelineTask,
  utcDay,
} from "../src/features/deal-tasks/lib/timeline-layout"
import {
  updateDealTaskRequest,
  upsertDealTaskTemplateRequest,
} from "../src/features/deal-tasks/schema/action"

const D = (iso: string) => new Date(`${iso}T00:00:00Z`)
const OPTS = { dayWidth: 10, rowHeight: 20, headerHeight: 30 }
const TASK = (over: Partial<TimelineTask> & { id: string }): TimelineTask => ({
  title: over.id,
  status: "open",
  startAt: null,
  dueAt: null,
  effectiveStart: D("2026-10-01"),
  dependsOn: [],
  conflicts: [],
  ...over,
})

beforeEach(() => {
  vi.useFakeTimers({ now: D("2026-10-01") })
})
afterEach(() => {
  vi.useRealTimers()
})

describe("s197 timeline layout", () => {
  test("bars span effective start to due day inclusive, rows sorted by start, a day of padding, undated tasks listed apart", () => {
    const layout = layoutTimeline(
      [
        TASK({
          id: "late",
          effectiveStart: D("2026-10-05"),
          dueAt: D("2026-10-06"),
        }),
        TASK({
          id: "early",
          effectiveStart: D("2026-10-02"),
          dueAt: D("2026-10-04"),
        }),
        TASK({ id: "undated" }),
      ],
      OPTS,
    )
    expect(layout.firstDay).toBe(utcDay(D("2026-10-01")))
    expect(layout.bars.map((b) => [b.id, b.x, b.width, b.y])).toEqual([
      ["early", 10, 30, 30],
      ["late", 40, 20, 50],
    ])
    expect(layout.unscheduled).toEqual(["undated"])
    // at least two weeks drawn, even for a short plan
    expect(layout.days).toBe(14)
    expect(layout.width).toBe(140)
    expect(layout.height).toBe(70)
  })

  test("a start after the due day is clamped to a one-day bar", () => {
    const layout = layoutTimeline(
      [
        TASK({
          id: "x",
          effectiveStart: D("2026-10-09"),
          dueAt: D("2026-10-03"),
        }),
      ],
      OPTS,
    )
    expect(layout.bars[0].width).toBe(10)
  })

  test("arrows join a predecessor's end to its successor's start and carry the conflict flag; an arrow to an undated task is dropped", () => {
    const layout = layoutTimeline(
      [
        TASK({
          id: "a",
          effectiveStart: D("2026-10-02"),
          dueAt: D("2026-10-03"),
        }),
        TASK({
          id: "b",
          effectiveStart: D("2026-10-06"),
          dueAt: D("2026-10-07"),
          dependsOn: ["a", "undated"],
        }),
        TASK({
          id: "c",
          effectiveStart: D("2026-10-02"),
          dueAt: D("2026-10-08"),
          dependsOn: ["a"],
          conflicts: ["a"],
        }),
        TASK({ id: "undated" }),
      ],
      OPTS,
    )
    expect(layout.arrows.map((a) => [a.from, a.to, a.conflict])).toEqual([
      ["a", "c", true],
      ["a", "b", false],
    ])
    const ab = layout.arrows.find((a) => a.to === "b")
    // a ends at x=30 (row 0, mid y 40); b starts at x=50 (row 2, mid y 80)
    expect(ab?.d).toBe("M 30 40 H 38 V 80 H 50")
  })

  test("a successor starting before the predecessor's end doubles back through the row gap", () => {
    const from = {
      id: "a",
      row: 0,
      startDay: 0,
      dueDay: 0,
      x: 0,
      width: 50,
      y: 30,
    }
    const to = {
      id: "b",
      row: 1,
      startDay: 0,
      dueDay: 0,
      x: 10,
      width: 20,
      y: 50,
    }
    expect(arrowPath({ from, to, rowHeight: 20 })).toBe(
      "M 50 40 H 58 V 50 H 2 V 60 H 10",
    )
  })

  test("RTL mirrors bars and ticks: day one sits at the right edge, arrows run leftward", () => {
    const tasks = [
      TASK({
        id: "a",
        effectiveStart: D("2026-10-02"),
        dueAt: D("2026-10-03"),
      }),
      TASK({
        id: "b",
        effectiveStart: D("2026-10-06"),
        dueAt: D("2026-10-06"),
        dependsOn: ["a"],
      }),
    ]
    const ltr = layoutTimeline(tasks, OPTS)
    const rtl = layoutTimeline(tasks, { ...OPTS, rtl: true })
    for (const [i, bar] of rtl.bars.entries()) {
      expect(bar.x).toBe(ltr.width - ltr.bars[i].x - ltr.bars[i].width)
    }
    expect(rtl.ticks[0].x).toBe(ltr.width - 10)
    // from a's LEFT edge (x=110) leftward to b's RIGHT edge (x=90)
    expect(rtl.arrows[0].d).toBe("M 110 40 H 102 V 60 H 90")
  })
})

describe("s197 draggedDates / openSuccessors", () => {
  const bar = {
    startDay: utcDay(D("2026-10-02")),
    dueDay: utcDay(D("2026-10-04")),
  }

  const task = { effectiveStart: D("2026-10-02"), dueAt: D("2026-10-04") }

  test("move shifts both ends and pins an explicit start; resize moves only the due day and never before the start", () => {
    expect(draggedDates({ bar, task, mode: "move", deltaDays: 2 })).toEqual({
      startAt: D("2026-10-04"),
      dueAt: D("2026-10-06"),
    })
    expect(draggedDates({ bar, task, mode: "resize", deltaDays: -1 })).toEqual({
      startAt: undefined,
      dueAt: D("2026-10-03"),
    })
    expect(draggedDates({ bar, task, mode: "resize", deltaDays: -9 })).toEqual({
      startAt: undefined,
      dueAt: D("2026-10-02"),
    })
    expect(draggedDates({ bar, task, mode: "move", deltaDays: 0 })).toBeNull()
    expect(
      draggedDates({
        bar: { ...bar, dueDay: bar.startDay },
        task,
        mode: "resize",
        deltaDays: -1,
      }),
    ).toBeNull()
    expect(DAY_MS).toBe(86_400_000)
  })

  test("a template task (start and due on ONE day, start at 15:00, due at 10:00 the next) keeps its times and never starts after it ends", () => {
    const t = {
      effectiveStart: new Date("2026-10-02T15:00:00Z"),
      dueAt: new Date("2026-10-02T15:00:00Z"),
    }
    const one = { startDay: utcDay(t.effectiveStart), dueDay: utcDay(t.dueAt) }
    expect(
      draggedDates({ bar: one, task: t, mode: "move", deltaDays: 3 }),
    ).toEqual({
      startAt: new Date("2026-10-05T15:00:00Z"),
      dueAt: new Date("2026-10-05T15:00:00Z"),
    })
    // resize back onto the start day: clamped to the start instant, not 422
    const two = {
      effectiveStart: new Date("2026-10-02T15:00:00Z"),
      dueAt: new Date("2026-10-03T10:00:00Z"),
    }
    const bar2 = {
      startDay: utcDay(two.effectiveStart),
      dueDay: utcDay(two.dueAt),
    }
    expect(
      draggedDates({ bar: bar2, task: two, mode: "resize", deltaDays: -1 }),
    ).toEqual({ startAt: undefined, dueAt: new Date("2026-10-02T15:00:00Z") })
  })

  test("moveToDay keeps the time of day (midnight when there is none); localToday is the LOCAL date in the UTC-midnight convention", () => {
    expect(
      moveToDay(new Date("2026-10-02T15:30:00Z"), utcDay(D("2026-10-09"))),
    ).toEqual(new Date("2026-10-09T15:30:00Z"))
    expect(moveToDay(null, utcDay(D("2026-10-09")))).toEqual(D("2026-10-09"))
    // a local wall clock of Oct 2 18:00 is Oct 2 whatever the UTC day is
    expect(localToday(new Date(2026, 9, 2, 18, 0, 0))).toBe(
      utcDay(D("2026-10-02")),
    )
    expect(localToday(new Date(2026, 9, 2, 0, 30, 0))).toBe(
      utcDay(D("2026-10-02")),
    )
  })

  test("openSuccessors = open tasks waiting on the task directly", () => {
    expect(
      openSuccessors(
        [
          { id: "a", status: "open", dependsOn: [] },
          { id: "b", status: "open", dependsOn: ["a"] },
          { id: "c", status: "done", dependsOn: ["a"] },
          { id: "d", status: "open", dependsOn: ["b"] },
        ],
        "a",
      ),
    ).toEqual(["b"])
  })
})

describe("s197 request schemas", () => {
  test("update accepts start/due + shiftSuccessors; template offsets are 0..365 integers", () => {
    expect(
      updateDealTaskRequest.parse({
        startAt: "2026-10-02T00:00:00Z",
        dueAt: "2026-10-04T00:00:00Z",
        shiftSuccessors: true,
      }),
    ).toMatchObject({ startAt: D("2026-10-02"), shiftSuccessors: true })
    expect(() =>
      updateDealTaskRequest.parse({ shiftSuccessors: "yes" }),
    ).toThrow()
    expect(() =>
      upsertDealTaskTemplateRequest.parse({ title: "x", startInDays: -1 }),
    ).toThrow()
    expect(() =>
      upsertDealTaskTemplateRequest.parse({ title: "x", startInDays: 366 }),
    ).toThrow()
    expect(
      upsertDealTaskTemplateRequest.parse({
        title: "x",
        startInDays: 2,
        dueInDays: 5,
      }),
    ).toMatchObject({ startInDays: 2, dueInDays: 5 })
  })
})
