import { describe, expect, test } from "vitest"
import {
  groupMyTasks,
  myTaskGroup,
} from "../src/features/deal-tasks/lib/my-tasks-groups"
import {
  localToday,
  utcDay,
} from "../src/features/deal-tasks/lib/timeline-layout"

/** s198 "My tasks" sections on the calendar's UTC-day convention. */
const TODAY = utcDay("2026-10-07T00:00:00Z")

describe("myTaskGroup", () => {
  test("overdue / today / six-day week / later / no date", () => {
    expect(myTaskGroup(null, TODAY)).toBe("noDate")
    expect(myTaskGroup("2026-10-06T23:59:59Z", TODAY)).toBe("overdue")
    expect(myTaskGroup("2026-10-07T00:00:00Z", TODAY)).toBe("today")
    expect(myTaskGroup("2026-10-07T23:59:59Z", TODAY)).toBe("today")
    expect(myTaskGroup("2026-10-08T00:00:00Z", TODAY)).toBe("week")
    expect(myTaskGroup("2026-10-13T12:00:00Z", TODAY)).toBe("week")
    expect(myTaskGroup("2026-10-14T00:00:00Z", TODAY)).toBe("later")
  })

  test("a viewer west of UTC late in the evening still sees a task due on their local today as today", () => {
    // 2026-10-07 21:00 in UTC-7 = 2026-10-08 04:00Z; the date picker stored
    // the local date as UTC midnight 2026-10-07
    const today = localToday(new Date(2026, 9, 7, 21, 0))
    expect(myTaskGroup("2026-10-07T00:00:00Z", today)).toBe("today")
  })
})

describe("groupMyTasks", () => {
  test("non-empty sections in display order; rows keep the server order", () => {
    const rows = [
      { id: "a", dueAt: "2026-10-20T00:00:00Z" },
      { id: "b", dueAt: null },
      { id: "c", dueAt: "2026-10-01T00:00:00Z" },
      { id: "d", dueAt: "2026-10-22T00:00:00Z" },
      { id: "e", dueAt: "2026-10-07T09:00:00Z" },
    ]
    expect(
      groupMyTasks(rows, TODAY).map((g) => [g.key, g.rows.map((r) => r.id)]),
    ).toEqual([
      ["overdue", ["c"]],
      ["today", ["e"]],
      ["later", ["a", "d"]],
      ["noDate", ["b"]],
    ])
  })

  test("no rows = no sections", () => {
    expect(groupMyTasks([], TODAY)).toEqual([])
  })
})
