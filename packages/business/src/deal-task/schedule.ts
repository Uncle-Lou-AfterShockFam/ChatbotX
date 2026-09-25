import type { DealTaskModel } from "@chatbotx.io/database/types"
import { validationException } from "../errors"

type Edge = { taskId: string; dependsOnTaskId: string }

/** Hard stop for any walk over a deal's graph, above anything the caps allow. */
export const DEPENDENCY_WALK_STEP_CAP = 4000

export function sameInstant(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null)
}

/** 422 `startAfterDue` when both are set and the start is later. */
export function assertStartNotAfterDue(
  startAt: Date | null,
  dueAt: Date | null,
): void {
  if (startAt && dueAt && startAt.getTime() > dueAt.getTime()) {
    throw validationException(
      "startAt",
      "The start must not be after the due date.",
      {
        reason: "startAfterDue",
      },
    )
  }
}

/**
 * Decorate a deal's tasks with the derived graph + timeline fields:
 * - `blockedBy`: OPEN tasks it waits on; `dependsOn`: every stored edge;
 * - `effectiveStart`: `startAt`, else the latest due date among the tasks it
 *   waits on (never after its own due date), else `createdAt`;
 * - `conflicts`: OPEN tasks it waits on that are due after this OPEN task's
 *   own start (or, with no start, its due date). A done task has none.
 */
export function withSchedule<T extends DealTaskModel>(
  tasks: T[],
  deps: Edge[],
): (T & {
  blockedBy: string[]
  dependsOn: string[]
  effectiveStart: Date
  conflicts: string[]
})[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const edgesByTask = new Map<string, string[]>()
  for (const dep of deps) {
    const list = edgesByTask.get(dep.taskId) ?? []
    list.push(dep.dependsOnTaskId)
    edgesByTask.set(dep.taskId, list)
  }
  return tasks.map((t) => {
    const dependsOn = edgesByTask.get(t.id) ?? []
    const preds = dependsOn
      .map((id) => byId.get(id))
      .filter((p): p is T => p !== undefined)
    const openPreds = preds.filter((p) => p.status === "open")
    const latestPredDue = preds.reduce<number | null>((max, p) => {
      const due = p.dueAt?.getTime()
      return due !== undefined && (max === null || due > max) ? due : max
    }, null)
    let start = t.startAt?.getTime() ?? latestPredDue ?? t.createdAt.getTime()
    if (!t.startAt && t.dueAt && start > t.dueAt.getTime()) {
      start = t.dueAt.getTime()
    }
    const bound = (t.startAt ?? t.dueAt)?.getTime()
    const conflicts =
      t.status === "open" && bound !== undefined
        ? openPreds
            .filter((p) => p.dueAt && p.dueAt.getTime() > bound)
            .map((p) => p.id)
        : []
    return {
      ...t,
      blockedBy: openPreds.map((p) => p.id),
      dependsOn,
      effectiveStart: new Date(start),
      conflicts,
    }
  })
}

/**
 * OPEN tasks reachable downstream of `from` (tasks that wait on it, directly
 * or through other open tasks). A done task is neither returned nor walked
 * through. Visited set = each task once (diamonds); the step cap is the hard
 * stop.
 */
export function downstreamOpen(props: {
  tasks: { id: string; status: string }[]
  edges: Edge[]
  from: string
}): string[] {
  const { tasks, edges, from } = props
  const open = new Set(
    tasks.filter((t) => t.status === "open").map((t) => t.id),
  )
  const successors = new Map<string, string[]>()
  for (const e of edges) {
    const list = successors.get(e.dependsOnTaskId) ?? []
    list.push(e.taskId)
    successors.set(e.dependsOnTaskId, list)
  }
  const visited = new Set<string>([from])
  const queue = [from]
  const out: string[] = []
  let steps = 0
  while (queue.length > 0) {
    const node = queue.shift() as string
    for (const next of successors.get(node) ?? []) {
      if (++steps > DEPENDENCY_WALK_STEP_CAP) {
        throw validationException(
          "taskId",
          "The dependency graph is too large to walk.",
          { reason: "dependencyWalkCap" },
        )
      }
      if (visited.has(next) || !open.has(next)) {
        continue
      }
      visited.add(next)
      out.push(next)
      queue.push(next)
    }
  }
  return out
}

export type EdgeRefusal =
  | "tooManyDependencies"
  | "dependencyExists"
  | "dependencyCycle"

/**
 * Bounded BFS: does `from` reach `to` along `dependsOn` edges? The visited
 * set makes it O(E); the step cap is the hard stop for a caller-supplied
 * graph the caps somehow let through.
 */
export function reaches(props: {
  edges: Edge[]
  from: string
  to: string
  field?: string
}): boolean {
  const { edges, from, to, field = "dependsOnTaskId" } = props
  const next = new Map<string, string[]>()
  for (const e of edges) {
    const list = next.get(e.taskId) ?? []
    list.push(e.dependsOnTaskId)
    next.set(e.taskId, list)
  }
  const visited = new Set<string>([from])
  const queue = [from]
  let steps = 0
  while (queue.length > 0) {
    const node = queue.shift() as string
    if (node === to) {
      return true
    }
    for (const dep of next.get(node) ?? []) {
      if (++steps > DEPENDENCY_WALK_STEP_CAP) {
        throw validationException(
          field,
          "The dependency graph is too large to check.",
          { reason: "dependencyWalkCap" },
        )
      }
      if (!visited.has(dep)) {
        visited.add(dep)
        queue.push(dep)
      }
    }
  }
  return false
}

/**
 * Why `taskId -> dependsOnTaskId` may not be added to `edges` (fan-in cap,
 * duplicate, cycle), or null. Shared by task and template edges (a template
 * edge is passed in the same `{taskId, dependsOnTaskId}` shape).
 */
export function edgeRefusal(props: {
  edges: Edge[]
  taskId: string
  dependsOnTaskId: string
  cap: number
  field?: string
}): EdgeRefusal | null {
  const { edges, taskId, dependsOnTaskId, cap, field } = props
  if (edges.filter((e) => e.taskId === taskId).length >= cap) {
    return "tooManyDependencies"
  }
  if (
    edges.some(
      (e) => e.taskId === taskId && e.dependsOnTaskId === dependsOnTaskId,
    )
  ) {
    return "dependencyExists"
  }
  if (reaches({ edges, from: dependsOnTaskId, to: taskId, field })) {
    return "dependencyCycle"
  }
  return null
}
