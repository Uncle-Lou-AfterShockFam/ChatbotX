/**
 * The workspace task calendar's grid (s197), in UTC DAYS: a task's due date
 * is stored as the UTC midnight of the chosen day and every task view shows
 * it in UTC, so the calendar groups by the same day (the broadcasts grid is
 * browser-local and would move a task across midnight). Weeks start Monday.
 */
import { dayToDate, moveToDay, utcDay } from "./timeline-layout"

export const TASK_CALENDAR_VIEWS = ["month", "week"] as const
export type TaskCalendarView = (typeof TASK_CALENDAR_VIEWS)[number]

/** 0 = Monday ... 6 = Sunday. */
const weekdayIndex = (day: number) => (dayToDate(day).getUTCDay() + 6) % 7

export function startOfWeekDay(day: number): number {
  return day - weekdayIndex(day)
}

function startOfMonthDay(day: number): number {
  const d = dayToDate(day)
  return utcDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)))
}

function endOfMonthDay(day: number): number {
  const d = dayToDate(day)
  return utcDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)))
}

/** Whole weeks (Monday first) covering the anchor's month: 4-6 rows of 7 days. */
export function monthGrid(anchorDay: number): number[][] {
  const first = startOfWeekDay(startOfMonthDay(anchorDay))
  const last = startOfWeekDay(endOfMonthDay(anchorDay)) + 6
  const weeks: number[][] = []
  for (let start = first; start <= last; start += 7) {
    weeks.push(Array.from({ length: 7 }, (_, i) => start + i))
  }
  return weeks
}

export function weekGrid(anchorDay: number): number[][] {
  const start = startOfWeekDay(anchorDay)
  return [Array.from({ length: 7 }, (_, i) => start + i)]
}

export function gridFor(view: TaskCalendarView, anchorDay: number): number[][] {
  return view === "month" ? monthGrid(anchorDay) : weekGrid(anchorDay)
}

/** The query range of a grid: its first day's midnight to the day after its last (exclusive). */
export function gridRange(grid: number[][]): { from: Date; to: Date } {
  const first = grid[0][0]
  const lastWeek = grid.at(-1) as number[]
  const last = lastWeek.at(-1) as number
  return { from: dayToDate(first), to: dayToDate(last + 1) }
}

/** The anchor one month / week earlier or later. */
export function stepAnchor(
  view: TaskCalendarView,
  anchorDay: number,
  direction: 1 | -1,
): number {
  if (view === "week") {
    return anchorDay + 7 * direction
  }
  const d = dayToDate(anchorDay)
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + direction, 1),
  )
  return utcDay(target)
}

export function isSameUtcMonth(a: number, b: number): boolean {
  const x = dayToDate(a)
  const y = dayToDate(b)
  return (
    x.getUTCFullYear() === y.getUTCFullYear() &&
    x.getUTCMonth() === y.getUTCMonth()
  )
}

export function groupByDueDay<T extends { dueAt: Date | string | null }>(
  rows: T[],
): Map<number, T[]> {
  const grouped = new Map<number, T[]>()
  for (const row of rows) {
    if (!row.dueAt) {
      continue
    }
    const day = utcDay(row.dueAt)
    grouped.set(day, [...(grouped.get(day) ?? []), row])
  }
  return grouped
}

export type ChipTone = "done" | "overdue" | "open"

export function chipTone(
  task: { status: "open" | "done"; dueAt: Date | string | null },
  todayDay: number,
): ChipTone {
  if (task.status === "done") {
    return "done"
  }
  return task.dueAt && utcDay(task.dueAt) < todayDay ? "overdue" : "open"
}

/**
 * The dates a drop on `targetDay` commits: the due date moves to that day and
 * an explicit start moves by the same number of days (the task keeps its
 * length), both keeping their time of day (`moveToDay`: a template task's
 * start and due can share a day with the start later in it). Null = dropped
 * on its own day.
 */
export function droppedDates(
  task: { startAt: Date | string | null; dueAt: Date | string | null },
  targetDay: number,
): { startAt?: Date; dueAt: Date } | null {
  if (!task.dueAt) {
    return null
  }
  const delta = targetDay - utcDay(task.dueAt)
  if (delta === 0) {
    return null
  }
  return {
    ...(task.startAt
      ? { startAt: moveToDay(task.startAt, utcDay(task.startAt) + delta) }
      : {}),
    dueAt: moveToDay(task.dueAt, targetDay),
  }
}
