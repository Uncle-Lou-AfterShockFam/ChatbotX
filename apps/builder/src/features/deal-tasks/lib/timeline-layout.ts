/**
 * Pure geometry of the deal-task timeline (s197): UTC days on the x axis,
 * one row per scheduled task, right-angle arrows from a predecessor's bar end
 * to its successor's bar start. DOM-free so it is unit-tested directly.
 */

export const DAY_MS = 86_400_000
/** Days of padding either side of the tasks, and the shortest drawn range. */
const PAD_DAYS = 1
const MIN_SPAN_DAYS = 14
/** Horizontal stub of an arrow before it turns. */
const STUB = 8

export type TimelineTask = {
  id: string
  title: string
  status: "open" | "done"
  startAt: Date | string | null
  dueAt: Date | string | null
  effectiveStart: Date | string
  dependsOn: string[]
  conflicts: string[]
}

export type TimelineBar = {
  id: string
  row: number
  /** Inclusive UTC day numbers (days since the epoch). */
  startDay: number
  dueDay: number
  x: number
  width: number
  y: number
}

export type TimelineArrow = {
  from: string
  to: string
  conflict: boolean
  /** SVG path data. */
  d: string
}

export type TimelineLayout = {
  firstDay: number
  days: number
  width: number
  height: number
  bars: TimelineBar[]
  arrows: TimelineArrow[]
  /** Tasks with no due date: listed beside the chart, never drawn. */
  unscheduled: string[]
  /** x of each day's left edge, first to last (the header ticks). */
  ticks: { day: number; x: number }[]
}

export type LayoutOptions = {
  dayWidth: number
  rowHeight: number
  headerHeight: number
  /** Right-to-left locale: day 0 sits at the right edge. */
  rtl?: boolean
}

/** Days since the epoch of a date's UTC calendar day. */
export function utcDay(value: Date | string): number {
  return Math.floor(new Date(value).getTime() / DAY_MS)
}

export function dayToDate(day: number): Date {
  return new Date(day * DAY_MS)
}

/**
 * `value` moved to UTC day `day`, keeping its time of day. A template task
 * carries the time its deal entered the stage while a date input writes UTC
 * midnight; keeping the time means a same-day edit never puts a start after
 * its due date (s197 probe). No value = that day's midnight.
 */
export function moveToDay(value: Date | string | null, day: number): Date {
  const ms = value ? new Date(value).getTime() : 0
  return new Date(day * DAY_MS + (((ms % DAY_MS) + DAY_MS) % DAY_MS))
}

/**
 * Today as the viewer sees it, in the UTC-day convention of the stored dates:
 * a date picked in a date input is the UTC midnight of the LOCAL date, so
 * "today" is the local date too (not the UTC day, which runs ahead or behind
 * for hours).
 */
export function localToday(now = new Date()): number {
  return utcDay(
    new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())),
  )
}

export function layoutTimeline(
  tasks: TimelineTask[],
  options: LayoutOptions,
): TimelineLayout {
  const { dayWidth, rowHeight, headerHeight, rtl = false } = options
  const scheduled = tasks
    .filter((t) => t.dueAt !== null)
    .map((t) => {
      const dueDay = utcDay(t.dueAt as Date | string)
      // A bar never starts after it ends (the server clamps too).
      const startDay = Math.min(utcDay(t.effectiveStart), dueDay)
      return { task: t, startDay, dueDay }
    })
    .sort(
      (a, b) =>
        a.startDay - b.startDay ||
        a.dueDay - b.dueDay ||
        a.task.id.localeCompare(b.task.id),
    )
  const unscheduled = tasks.filter((t) => t.dueAt === null).map((t) => t.id)
  const today = localToday()
  const first =
    scheduled.length === 0
      ? today
      : Math.min(...scheduled.map((s) => s.startDay))
  const last =
    scheduled.length === 0 ? today : Math.max(...scheduled.map((s) => s.dueDay))
  const firstDay = first - PAD_DAYS
  const days = Math.max(last + PAD_DAYS - firstDay + 1, MIN_SPAN_DAYS)
  const width = days * dayWidth
  const height = headerHeight + scheduled.length * rowHeight
  const mirror = (x: number, w = 0) => (rtl ? width - x - w : x)

  const bars: TimelineBar[] = scheduled.map((s, row) => {
    const w = (s.dueDay - s.startDay + 1) * dayWidth
    const x = (s.startDay - firstDay) * dayWidth
    return {
      id: s.task.id,
      row,
      startDay: s.startDay,
      dueDay: s.dueDay,
      x: mirror(x, w),
      width: w,
      y: headerHeight + row * rowHeight,
    }
  })
  const barById = new Map(bars.map((b) => [b.id, b]))
  const arrows: TimelineArrow[] = []
  for (const s of scheduled) {
    const to = barById.get(s.task.id) as TimelineBar
    for (const predId of s.task.dependsOn) {
      const from = barById.get(predId)
      if (!from) {
        continue
      }
      arrows.push({
        from: predId,
        to: to.id,
        conflict: s.task.conflicts.includes(predId),
        d: arrowPath({ from, to, rowHeight, rtl }),
      })
    }
  }
  const ticks = Array.from({ length: days }, (_, i) => ({
    day: firstDay + i,
    x: mirror(i * dayWidth, dayWidth),
  }))
  return { firstDay, days, width, height, bars, arrows, unscheduled, ticks }
}

/**
 * From the END of `from` (its right edge, or left in RTL) to the START of
 * `to`. When the successor starts far enough along, one elbow; otherwise the
 * path drops to the gap between the rows and doubles back.
 */
export function arrowPath(props: {
  from: TimelineBar
  to: TimelineBar
  rowHeight: number
  rtl?: boolean
}): string {
  const { from, to, rowHeight, rtl = false } = props
  const dir = rtl ? -1 : 1
  const x1 = rtl ? from.x : from.x + from.width
  const y1 = from.y + rowHeight / 2
  const x2 = rtl ? to.x + to.width : to.x
  const y2 = to.y + rowHeight / 2
  const out = x1 + dir * STUB
  if ((x2 - out) * dir >= STUB) {
    return `M ${x1} ${y1} H ${out} V ${y2} H ${x2}`
  }
  const back = x2 - dir * STUB
  const gapY = to.y + (to.y > from.y ? 0 : rowHeight)
  return `M ${x1} ${y1} H ${out} V ${gapY} H ${back} V ${y2} H ${x2}`
}

/**
 * The dates a drag commits. `mode` = move (both ends by `deltaDays`) or
 * resize (the due day only, never before the start day). Returns null when
 * nothing changes. A task without its own `startAt` gets one on a move: the
 * bar the user dragged is what they meant. Times of day are kept
 * (`moveToDay`) and the start is never after the due date.
 */
export function draggedDates(props: {
  bar: Pick<TimelineBar, "startDay" | "dueDay">
  task: Pick<TimelineTask, "effectiveStart" | "dueAt">
  mode: "move" | "resize"
  deltaDays: number
}): { startAt: Date | undefined; dueAt: Date } | null {
  const { bar, task, mode, deltaDays } = props
  if (deltaDays === 0) {
    return null
  }
  if (mode === "move") {
    const dueAt = moveToDay(task.dueAt, bar.dueDay + deltaDays)
    const startAt = moveToDay(task.effectiveStart, bar.startDay + deltaDays)
    return { startAt: startAt > dueAt ? dueAt : startAt, dueAt }
  }
  const dueDay = Math.max(bar.dueDay + deltaDays, bar.startDay)
  if (dueDay === bar.dueDay) {
    return null
  }
  const dueAt = moveToDay(task.dueAt, dueDay)
  const start = new Date(task.effectiveStart)
  return { startAt: undefined, dueAt: dueAt < start ? start : dueAt }
}

/** Open tasks that wait on `taskId` directly (the shift dialog's count uses the full walk server-side). */
export function openSuccessors(
  tasks: Pick<TimelineTask, "id" | "status" | "dependsOn">[],
  taskId: string,
): string[] {
  return tasks
    .filter((t) => t.status === "open" && t.dependsOn.includes(taskId))
    .map((t) => t.id)
}
