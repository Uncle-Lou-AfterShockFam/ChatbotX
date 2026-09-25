import { utcDay } from "./timeline-layout"

export type MyTasksGroupKey = "overdue" | "today" | "week" | "later" | "noDate"

export const MY_TASKS_GROUP_ORDER: MyTasksGroupKey[] = [
  "overdue",
  "today",
  "week",
  "later",
  "noDate",
]

/**
 * The "My tasks" section of an open task (s198), on the same UTC-day
 * convention as the calendar (`todayDay` = `localToday()`): "week" = the six
 * days after today.
 */
export function myTaskGroup(
  dueAt: Date | string | null,
  todayDay: number,
): MyTasksGroupKey {
  if (!dueAt) {
    return "noDate"
  }
  const day = utcDay(dueAt)
  if (day < todayDay) {
    return "overdue"
  }
  if (day === todayDay) {
    return "today"
  }
  return day <= todayDay + 6 ? "week" : "later"
}

/** Non-empty sections in display order; rows keep their server order. */
export function groupMyTasks<T extends { dueAt: Date | string | null }>(
  rows: T[],
  todayDay: number,
): { key: MyTasksGroupKey; rows: T[] }[] {
  const by = new Map<MyTasksGroupKey, T[]>()
  for (const row of rows) {
    const key = myTaskGroup(row.dueAt, todayDay)
    const list = by.get(key)
    if (list) {
      list.push(row)
    } else {
      by.set(key, [row])
    }
  }
  return MY_TASKS_GROUP_ORDER.filter((key) => by.has(key)).map((key) => ({
    key,
    rows: by.get(key) ?? [],
  }))
}
