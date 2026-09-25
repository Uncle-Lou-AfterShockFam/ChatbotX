"use client"

import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { useFormatter, useLocale, useTranslations } from "next-intl"
import { type PointerEvent, useMemo, useRef, useState } from "react"
import {
  dayToDate,
  draggedDates,
  layoutTimeline,
  type TimelineBar,
  utcDay,
} from "../lib/timeline-layout"
import type { DealTaskWithBlockersResource } from "../schema/resource"

const DAY_WIDTH = 28
const ROW_HEIGHT = 32
const HEADER_HEIGHT = 36
const BAR_INSET = 7
const RESIZE_HANDLE = 8
const RTL_LANGS = new Set(["ar", "he"])
const STEP_BY_KEY: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 }

function barClass(done: boolean, conflict: boolean): string {
  if (done) {
    return "fill-muted-foreground/40"
  }
  return conflict
    ? "cursor-grab fill-destructive/80"
    : "cursor-grab fill-primary"
}

type Drag = {
  id: string
  mode: "move" | "resize"
  originX: number
  deltaDays: number
}

/**
 * The deal's tasks on a day scale: one bar per task (effective start to due
 * date), a right-angle arrow per dependency (red = the successor starts
 * before its predecessor is due). Drag a bar to move it, drag its end to
 * change the due date; arrow keys move a focused bar by a day (Shift = due
 * date only). Every change goes through `onReschedule`, which asks about
 * successors. The chart scrolls inside its own box.
 */
export function TasksTimeline({
  tasks,
  busy,
  onReschedule,
}: {
  tasks: DealTaskWithBlockersResource[]
  busy: boolean
  onReschedule: (taskId: string, dates: { startAt?: Date; dueAt: Date }) => void
}) {
  const t = useTranslations()
  const format = useFormatter()
  const rtl = RTL_LANGS.has(useLocale().split("-")[0])
  const layout = useMemo(
    () =>
      layoutTimeline(tasks, {
        dayWidth: DAY_WIDTH,
        rowHeight: ROW_HEIGHT,
        headerHeight: HEADER_HEIGHT,
        rtl,
      }),
    [tasks, rtl],
  )
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const today = utcDay(new Date())
  const todayTick = layout.ticks.find((tick) => tick.day === today)
  const dir = rtl ? -1 : 1

  const commit = (bar: TimelineBar, mode: Drag["mode"], deltaDays: number) => {
    const dates = draggedDates({ bar, mode, deltaDays })
    if (dates) {
      onReschedule(bar.id, dates)
    }
  }
  const onPointerDown = (
    e: PointerEvent<SVGRectElement>,
    bar: TimelineBar,
    mode: Drag["mode"],
  ) => {
    if (busy || byId.get(bar.id)?.status === "done") {
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    const next = { id: bar.id, mode, originX: e.clientX, deltaDays: 0 }
    dragRef.current = next
    setDrag(next)
  }
  const onPointerMove = (e: PointerEvent<SVGRectElement>) => {
    const current = dragRef.current
    if (!current) {
      return
    }
    const deltaDays = Math.round(
      ((e.clientX - current.originX) * dir) / DAY_WIDTH,
    )
    if (deltaDays !== current.deltaDays) {
      const next = { ...current, deltaDays }
      dragRef.current = next
      setDrag(next)
    }
  }
  /** An interrupted gesture (browser scroll, lost capture): drop it uncommitted. */
  const onPointerCancel = () => {
    dragRef.current = null
    setDrag(null)
  }
  const onPointerUp = (bar: TimelineBar) => {
    const current = dragRef.current
    dragRef.current = null
    setDrag(null)
    if (current && current.id === bar.id) {
      commit(bar, current.mode, current.deltaDays)
    }
  }
  const onKeyDown = (e: React.KeyboardEvent, bar: TimelineBar) => {
    if (busy || byId.get(bar.id)?.status === "done") {
      return
    }
    const step = (STEP_BY_KEY[e.key] ?? 0) * dir
    if (step === 0) {
      return
    }
    e.preventDefault()
    commit(bar, e.shiftKey ? "resize" : "move", step)
  }
  /** The bar as drawn mid-drag (committed on release). */
  const drawn = (bar: TimelineBar) => {
    if (!drag || drag.id !== bar.id || drag.deltaDays === 0) {
      return bar
    }
    const shift = drag.deltaDays * DAY_WIDTH
    if (drag.mode === "move") {
      return { ...bar, x: bar.x + shift * dir }
    }
    const width = Math.max(bar.width + shift, DAY_WIDTH)
    return { ...bar, width, x: rtl ? bar.x + bar.width - width : bar.x }
  }

  if (tasks.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">{t("deals.tasks.none")}</p>
    )
  }
  return (
    <div className="space-y-2" data-testid="deal-tasks-timeline">
      {layout.bars.length > 0 ? (
        <div className="flex rounded-md border">
          <ul
            className="w-32 shrink-0 border-e text-xs sm:w-40"
            style={{ paddingTop: HEADER_HEIGHT }}
          >
            {layout.bars.map((bar) => {
              const task = byId.get(bar.id)
              return (
                <li
                  className="flex items-center gap-1 truncate px-2"
                  key={bar.id}
                  style={{ height: ROW_HEIGHT }}
                  title={task?.title}
                >
                  <span
                    className={
                      task?.status === "done"
                        ? "truncate text-muted-foreground line-through"
                        : "truncate"
                    }
                  >
                    {task?.title}
                  </span>
                </li>
              )
            })}
          </ul>
          <div className="min-w-0 flex-1 overflow-x-auto">
            <svg
              aria-label={t("deals.tasks.timeline")}
              className="block select-none"
              height={layout.height}
              role="img"
              width={layout.width}
            >
              <title>{t("deals.tasks.timeline")}</title>
              <defs>
                <marker
                  id="tl-arrow"
                  markerHeight="6"
                  markerWidth="6"
                  orient="auto-start-reverse"
                  refX="5"
                  refY="3"
                >
                  <path
                    className="fill-muted-foreground"
                    d="M0,0 L6,3 L0,6 z"
                  />
                </marker>
                <marker
                  id="tl-arrow-conflict"
                  markerHeight="6"
                  markerWidth="6"
                  orient="auto-start-reverse"
                  refX="5"
                  refY="3"
                >
                  <path className="fill-destructive" d="M0,0 L6,3 L0,6 z" />
                </marker>
              </defs>
              {layout.ticks.map((tick) => {
                const date = dayToDate(tick.day)
                const weekend = [0, 6].includes(date.getUTCDay())
                return (
                  <g key={tick.day}>
                    {weekend ? (
                      <rect
                        className="fill-muted/60"
                        height={layout.height - HEADER_HEIGHT}
                        width={DAY_WIDTH}
                        x={tick.x}
                        y={HEADER_HEIGHT}
                      />
                    ) : null}
                    {date.getUTCDate() === 1 || tick.day === layout.firstDay ? (
                      <text
                        className="fill-muted-foreground text-[10px]"
                        x={tick.x + 2}
                        y={12}
                      >
                        {format.dateTime(date, {
                          month: "short",
                          timeZone: "UTC",
                        })}
                      </text>
                    ) : null}
                    <text
                      className="fill-muted-foreground text-[10px]"
                      textAnchor="middle"
                      x={tick.x + DAY_WIDTH / 2}
                      y={28}
                    >
                      {date.getUTCDate()}
                    </text>
                  </g>
                )
              })}
              {todayTick ? (
                <line
                  className="stroke-primary"
                  data-testid="timeline-today"
                  strokeDasharray="3 3"
                  x1={todayTick.x + DAY_WIDTH / 2}
                  x2={todayTick.x + DAY_WIDTH / 2}
                  y1={HEADER_HEIGHT - 4}
                  y2={layout.height}
                />
              ) : null}
              {layout.arrows.map((arrow) => (
                <path
                  className={
                    arrow.conflict
                      ? "fill-none stroke-destructive"
                      : "fill-none stroke-muted-foreground"
                  }
                  d={arrow.d}
                  data-conflict={arrow.conflict ? "true" : undefined}
                  data-testid={`timeline-arrow-${arrow.from}-${arrow.to}`}
                  key={`${arrow.from}-${arrow.to}`}
                  markerEnd={
                    arrow.conflict
                      ? "url(#tl-arrow-conflict)"
                      : "url(#tl-arrow)"
                  }
                  strokeWidth={1.25}
                />
              ))}
              {layout.bars.map((bar) => {
                const task = byId.get(bar.id)
                const shown = drawn(bar)
                const done = task?.status === "done"
                const conflict = (task?.conflicts.length ?? 0) > 0
                const handleX = rtl
                  ? shown.x
                  : shown.x + shown.width - RESIZE_HANDLE
                return (
                  // biome-ignore lint/a11y/useSemanticElements: an SVG bar has no semantic element; role + label + keys make it operable
                  <g
                    aria-label={t("deals.tasks.barLabel", {
                      title: task?.title ?? "",
                      start: format.dateTime(dayToDate(bar.startDay), {
                        dateStyle: "medium",
                        timeZone: "UTC",
                      }),
                      due: format.dateTime(dayToDate(bar.dueDay), {
                        dateStyle: "medium",
                        timeZone: "UTC",
                      }),
                    })}
                    className="outline-none focus-visible:[&>rect:first-child]:stroke-2 focus-visible:[&>rect:first-child]:stroke-ring"
                    data-testid={`timeline-bar-${bar.id}`}
                    key={bar.id}
                    onKeyDown={(e) => onKeyDown(e, bar)}
                    role="button"
                    tabIndex={done ? -1 : 0}
                  >
                    <rect
                      className={barClass(done, conflict)}
                      height={ROW_HEIGHT - BAR_INSET * 2}
                      onLostPointerCapture={onPointerCancel}
                      onPointerCancel={onPointerCancel}
                      onPointerDown={(e) => onPointerDown(e, bar, "move")}
                      onPointerMove={onPointerMove}
                      onPointerUp={() => onPointerUp(bar)}
                      rx={4}
                      style={{ touchAction: "none" }}
                      width={shown.width}
                      x={shown.x}
                      y={shown.y + BAR_INSET}
                    />
                    {done ? null : (
                      <rect
                        className="cursor-ew-resize fill-transparent"
                        data-testid={`timeline-resize-${bar.id}`}
                        height={ROW_HEIGHT - BAR_INSET * 2}
                        onLostPointerCapture={onPointerCancel}
                        onPointerCancel={onPointerCancel}
                        onPointerDown={(e) => onPointerDown(e, bar, "resize")}
                        onPointerMove={onPointerMove}
                        onPointerUp={() => onPointerUp(bar)}
                        style={{ touchAction: "none" }}
                        width={RESIZE_HANDLE}
                        x={handleX}
                        y={shown.y + BAR_INSET}
                      />
                    )}
                  </g>
                )
              })}
            </svg>
          </div>
        </div>
      ) : null}
      {tasks.some((task) => task.conflicts.length > 0) ? (
        <Badge data-testid="timeline-conflicts" variant="destructive">
          {t("deals.tasks.conflicts", {
            count: tasks.filter((task) => task.conflicts.length > 0).length,
          })}
        </Badge>
      ) : null}
      {layout.unscheduled.length > 0 ? (
        <div className="text-xs" data-testid="timeline-unscheduled">
          <p className="font-medium text-muted-foreground">
            {t("deals.tasks.unscheduled")}
          </p>
          <ul className="list-disc ps-4">
            {layout.unscheduled.map((id) => (
              <li key={id}>{byId.get(id)?.title}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-muted-foreground text-xs">
        {t("deals.tasks.timelineHint")}
      </p>
    </div>
  )
}
