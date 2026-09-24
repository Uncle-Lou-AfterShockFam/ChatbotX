import {
  and,
  type DatabaseClient,
  db,
  eq,
  inArray,
  sql,
} from "@chatbotx.io/database/client"
import {
  MAX_DEAL_TASK_DEPENDENCIES_PER_TASK,
  MAX_DEAL_TASK_DESCRIPTION_LENGTH,
  MAX_DEAL_TASK_TITLE_LENGTH,
  MAX_DEAL_TASKS_PER_DEAL,
} from "@chatbotx.io/database/partials"
import {
  dealActivityModel,
  dealDependencyModel,
  dealTaskModel,
} from "@chatbotx.io/database/schema"
import type {
  DealDependencyModel,
  DealModel,
  DealTaskModel,
} from "@chatbotx.io/database/types"
import {
  type DealTaskEventMetadata,
  emitDealTaskAssigned,
  emitDealTaskCompleted,
  emitDealTaskCreated,
  emitDealTaskOverdue,
} from "@chatbotx.io/events"
import { createId } from "@chatbotx.io/utils"
import { BaseService } from "../base.service"
import { dealService } from "../deal/service"
import {
  dealEventMetadata,
  parseDateOrNull,
  parseOptionalText,
  parseRequiredText,
  resolveWorkspaceMember,
} from "../deal/shared"
import { notFoundException, validationException } from "../errors"
import { logger } from "../logger"
import { notificationService } from "../notification/service"
import type { DealViewer } from "../pipeline/access"

const TASK_NOT_FOUND = "Task not found"
/** Hard stop for the cycle walk, above any reachable graph under the caps. */
export const DEPENDENCY_WALK_STEP_CAP = 4000

export type DealTaskData = {
  title: string
  description?: string | null
  assigneeId?: string | null
  dueAt?: Date | string | null
  templateId?: string | null
}
export type DealTaskUpdateData = Partial<
  Pick<DealTaskData, "title" | "description" | "assigneeId" | "dueAt">
>
export type DealTaskWithBlockers = DealTaskModel & {
  /** Ids of OPEN tasks this one waits on (derived, never stored). */
  blockedBy: string[]
  /** Every task this one waits on, open or done (the stored edges). */
  dependsOn: string[]
}

/**
 * Tasks on a deal. Every write = row (+ DealActivity on create/complete) in
 * ONE transaction, then the event after commit, then nothing else: an emit
 * failure never un-does the write. "Blocked" is derived from DealDependency
 * rows whose blocker is still open; nothing stores it, so concurrent
 * completes cannot race an "unblock" write.
 */
export class DealTaskService extends BaseService {
  /** With a `viewer` (s193) the DEAL must be readable by them first (404 otherwise). */
  async findOrFail(props: {
    workspaceId: string
    dealId: string
    taskId: string
    viewer?: DealViewer | null
    tx?: DatabaseClient
  }): Promise<DealTaskModel> {
    const { workspaceId, dealId, taskId, viewer, tx = db } = props
    if (viewer) {
      await dealService.findOrFail({ workspaceId, id: dealId, viewer, tx })
    }
    const [task] = await tx
      .select()
      .from(dealTaskModel)
      .where(
        and(
          eq(dealTaskModel.id, taskId),
          eq(dealTaskModel.dealId, dealId),
          eq(dealTaskModel.workspaceId, workspaceId),
        ),
      )
      .limit(1)
    if (!task) {
      throw notFoundException(TASK_NOT_FOUND)
    }
    return task
  }

  /** Tasks of a deal, oldest first, each with the ids of the OPEN tasks it waits on. */
  async list(props: {
    workspaceId: string
    dealId: string
    viewer?: DealViewer | null
    tx?: DatabaseClient
  }): Promise<DealTaskWithBlockers[]> {
    const { workspaceId, dealId, viewer, tx = db } = props
    await dealService.findOrFail({ workspaceId, id: dealId, viewer, tx })
    const tasks = await tx
      .select()
      .from(dealTaskModel)
      .where(eq(dealTaskModel.dealId, dealId))
      .orderBy(dealTaskModel.createdAt, dealTaskModel.id)
    if (tasks.length === 0) {
      return []
    }
    const deps = await tx
      .select()
      .from(dealDependencyModel)
      .where(
        inArray(
          dealDependencyModel.taskId,
          tasks.map((t) => t.id),
        ),
      )
    const openIds = new Set(
      tasks.filter((t) => t.status === "open").map((t) => t.id),
    )
    const blockersByTask = new Map<string, string[]>()
    const edgesByTask = new Map<string, string[]>()
    for (const dep of deps) {
      const edges = edgesByTask.get(dep.taskId) ?? []
      edges.push(dep.dependsOnTaskId)
      edgesByTask.set(dep.taskId, edges)
      if (!openIds.has(dep.dependsOnTaskId)) {
        continue
      }
      const list = blockersByTask.get(dep.taskId) ?? []
      list.push(dep.dependsOnTaskId)
      blockersByTask.set(dep.taskId, list)
    }
    return tasks.map((t) => ({
      ...t,
      blockedBy: blockersByTask.get(t.id) ?? [],
      dependsOn: edgesByTask.get(t.id) ?? [],
    }))
  }

  /**
   * Tasks across several deals (s195 Contact / Company 360): only the deals
   * the viewer may read are consulted (`dealService.list` semantics), newest
   * due first, open before done. No blocker graph: the drawer owns that.
   */
  async listByDealIds(props: {
    workspaceId: string
    dealIds: string[]
    viewer?: DealViewer | null
    limit?: number
    tx?: DatabaseClient
  }): Promise<DealTaskModel[]> {
    const { workspaceId, viewer, tx = db } = props
    const limit = Math.min(Math.max(Math.trunc(props.limit ?? 100), 1), 200)
    if (props.dealIds.length === 0) {
      return []
    }
    const visible = await dealService.list({
      workspaceId,
      viewer,
      perPage: props.dealIds.length,
      page: 1,
    })
    const allowed = new Set(visible.data.map((d) => d.id))
    const dealIds = props.dealIds.filter((id) => allowed.has(id))
    if (dealIds.length === 0) {
      return []
    }
    return await tx
      .select()
      .from(dealTaskModel)
      .where(
        and(
          eq(dealTaskModel.workspaceId, workspaceId),
          inArray(dealTaskModel.dealId, dealIds),
        ),
      )
      .orderBy(
        dealTaskModel.status,
        sql`${dealTaskModel.dueAt} asc nulls last`,
        dealTaskModel.createdAt,
      )
      .limit(limit)
  }

  async create(props: {
    workspaceId: string
    dealId: string
    data: DealTaskData
    actorId?: string | null
    viewer?: DealViewer | null
  }): Promise<DealTaskModel> {
    const { workspaceId, dealId, viewer } = props
    const actorId = props.actorId ?? null
    const parsed = this.parseData(props.data)
    const { task, deal } = await db.transaction(async (tx) => {
      const current = await dealService.findOrFail({
        workspaceId,
        id: dealId,
        viewer,
        tx,
      })
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(dealTaskModel)
        .where(eq(dealTaskModel.dealId, dealId))
      if (Number(count) >= MAX_DEAL_TASKS_PER_DEAL) {
        throw validationException(
          "dealId",
          `A deal holds at most ${MAX_DEAL_TASKS_PER_DEAL} tasks.`,
          { reason: "tooManyTasks" },
        )
      }
      const assigneeId = await this.resolveAssignee({
        workspaceId,
        assigneeId: props.data.assigneeId,
        tx,
      })
      const row = await this.insertInTx({
        tx,
        workspaceId,
        dealId,
        values: {
          ...parsed,
          assigneeId,
          templateId: props.data.templateId ?? null,
        },
        actorId,
      })
      return { task: row, deal: current }
    })
    await this.audit("deal.task.create", task.id)
    await this.emitFor(deal, task, emitDealTaskCreated, {})
    if (task.assigneeId) {
      await this.emitFor(deal, task, emitDealTaskAssigned, {
        previousAssigneeId: null,
      })
      await this.notifyAssignee(deal, task, actorId)
    }
    return task
  }

  /**
   * Title / description / assignee / due date. Only the assignee change is an
   * event (`taskAssigned`); a due date moved into the future re-arms the
   * overdue scanner.
   */
  async update(props: {
    workspaceId: string
    dealId: string
    taskId: string
    data: DealTaskUpdateData
    actorId?: string | null
    viewer?: DealViewer | null
  }): Promise<DealTaskModel> {
    const { workspaceId, dealId, taskId, data, viewer } = props
    const set: Partial<typeof dealTaskModel.$inferInsert> = {}
    const result = await db.transaction(async (tx) => {
      const current = await this.findOrFail({
        workspaceId,
        dealId,
        taskId,
        viewer,
        tx,
      })
      if (data.title !== undefined) {
        const title = this.parseTitle(data.title)
        if (title !== current.title) {
          set.title = title
        }
      }
      if (data.description !== undefined) {
        const description = this.parseDescription(data.description)
        if (description !== current.description) {
          set.description = description
        }
      }
      let previousAssigneeId: string | null | undefined
      if (data.assigneeId !== undefined) {
        const assigneeId = await this.resolveAssignee({
          workspaceId,
          assigneeId: data.assigneeId,
          tx,
        })
        if (assigneeId !== current.assigneeId) {
          set.assigneeId = assigneeId
          previousAssigneeId = current.assigneeId
        }
      }
      if (data.dueAt !== undefined) {
        const dueAt = this.parseDueAt(data.dueAt)
        if ((dueAt?.getTime() ?? null) !== (current.dueAt?.getTime() ?? null)) {
          set.dueAt = dueAt
          if (dueAt && dueAt.getTime() > Date.now()) {
            set.overdueNotifiedAt = null
          }
        }
      }
      if (Object.keys(set).length === 0) {
        return { task: current, changed: false, previousAssigneeId }
      }
      // An assignee change is pinned to the assignee this call read: two
      // concurrent identical reassignments touch one row between them, so
      // the assignee is notified once (skeptic MEDIUM, s194).
      const [updated] = await tx
        .update(dealTaskModel)
        .set(set)
        .where(
          previousAssigneeId === undefined
            ? eq(dealTaskModel.id, taskId)
            : and(
                eq(dealTaskModel.id, taskId),
                sql`${dealTaskModel.assigneeId} is not distinct from ${previousAssigneeId}`,
              ),
        )
        .returning()
      if (!updated) {
        if (previousAssigneeId === undefined) {
          throw notFoundException(TASK_NOT_FOUND)
        }
        // lost the race (or the task is gone: findOrFail says which)
        const again = await this.findOrFail({
          workspaceId,
          dealId,
          taskId,
          viewer,
          tx,
        })
        return { task: again, changed: false, previousAssigneeId: undefined }
      }
      const deal = await dealService.findOrFail({ workspaceId, id: dealId, tx })
      return { task: updated, changed: true, previousAssigneeId, deal }
    })
    if (!result.changed) {
      return result.task
    }
    await this.audit("deal.task.update", taskId)
    if (
      result.previousAssigneeId !== undefined &&
      result.task.assigneeId &&
      result.deal
    ) {
      await this.emitFor(result.deal, result.task, emitDealTaskAssigned, {
        previousAssigneeId: result.previousAssigneeId,
      })
      await this.notifyAssignee(result.deal, result.task, props.actorId ?? null)
    }
    return result.task
  }

  /**
   * Complete a task. Refuses (422 `taskBlocked`) while any blocker is still
   * open unless `force`. The UPDATE is pinned to `status = 'open'`: a second
   * concurrent complete touches 0 rows, returns the current row and writes no
   * second activity / event (idempotent).
   */
  async complete(props: {
    workspaceId: string
    dealId: string
    taskId: string
    actorId?: string | null
    force?: boolean
    viewer?: DealViewer | null
  }): Promise<{ task: DealTaskModel; completed: boolean }> {
    const { workspaceId, dealId, taskId, viewer } = props
    const actorId = props.actorId ?? null
    const outcome = await db.transaction(async (tx) => {
      const current = await this.findOrFail({
        workspaceId,
        dealId,
        taskId,
        viewer,
        tx,
      })
      if (current.status === "done") {
        return { task: current, completed: false as const }
      }
      if (!props.force) {
        const open = await this.openBlockers({ taskId, tx })
        if (open.length > 0) {
          throw validationException(
            "taskId",
            "This task is blocked by an open task; complete that first.",
            { reason: "taskBlocked", blockedBy: open.join(",") },
          )
        }
      }
      const [done] = await tx
        .update(dealTaskModel)
        .set({
          status: "done",
          completedAt: new Date(),
          completedById: actorId,
        })
        .where(
          and(eq(dealTaskModel.id, taskId), eq(dealTaskModel.status, "open")),
        )
        .returning()
      if (!done) {
        // Lost the race to another complete: nothing to record.
        return { task: current, completed: false as const }
      }
      await this.recordActivity({
        tx,
        dealId,
        type: "taskCompleted",
        actorId,
        payload: { taskId, title: done.title },
      })
      const deal = await dealService.findOrFail({ workspaceId, id: dealId, tx })
      return { task: done, completed: true as const, deal }
    })
    if (!outcome.completed) {
      return outcome
    }
    await this.audit("deal.task.complete", taskId)
    await this.emitFor(outcome.deal, outcome.task, emitDealTaskCompleted, {
      completedById: actorId,
    })
    return { task: outcome.task, completed: true }
  }

  /** The inverse predicate: `status = 'done'` -> open again; no activity, no event. */
  async reopen(props: {
    workspaceId: string
    dealId: string
    taskId: string
    viewer?: DealViewer | null
  }): Promise<DealTaskModel> {
    const { workspaceId, dealId, taskId, viewer } = props
    const task = await db.transaction(async (tx) => {
      const current = await this.findOrFail({
        workspaceId,
        dealId,
        taskId,
        viewer,
        tx,
      })
      if (current.status === "open") {
        return { task: current, changed: false as const }
      }
      const [reopened] = await tx
        .update(dealTaskModel)
        .set({
          status: "open",
          completedAt: null,
          completedById: null,
          overdueNotifiedAt: null,
        })
        .where(
          and(eq(dealTaskModel.id, taskId), eq(dealTaskModel.status, "done")),
        )
        .returning()
      return { task: reopened ?? current, changed: true as const }
    })
    if (task.changed) {
      await this.audit("deal.task.reopen", taskId)
    }
    return task.task
  }

  async remove(props: {
    workspaceId: string
    dealId: string
    taskId: string
    viewer?: DealViewer | null
  }): Promise<void> {
    const { workspaceId, dealId, taskId, viewer } = props
    await this.findOrFail({ workspaceId, dealId, taskId, viewer })
    // DealDependency rows cascade on both columns.
    await db.delete(dealTaskModel).where(eq(dealTaskModel.id, taskId))
    await this.audit("deal.task.delete", taskId)
  }

  /**
   * Make `taskId` wait on `dependsOnTaskId`. Both tasks belong to the deal,
   * the per-task fan-in is capped, and a bounded BFS over the deal's edges
   * refuses a cycle; the per-deal advisory lock serialises two concurrent
   * inserts that would each pass the check alone (A->B and B->A).
   */
  async addDependency(props: {
    workspaceId: string
    dealId: string
    taskId: string
    dependsOnTaskId: string
    viewer?: DealViewer | null
  }): Promise<DealDependencyModel> {
    const { workspaceId, dealId, taskId, dependsOnTaskId, viewer } = props
    if (taskId === dependsOnTaskId) {
      throw validationException(
        "dependsOnTaskId",
        "A task cannot depend on itself.",
        { reason: "dependencySelf" },
      )
    }
    const row = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`deal-deps:${dealId}`}))`,
      )
      await this.findOrFail({ workspaceId, dealId, taskId, viewer, tx })
      await this.findOrFail({
        workspaceId,
        dealId,
        taskId: dependsOnTaskId,
        tx,
      })
      const edges = await tx
        .select({
          taskId: dealDependencyModel.taskId,
          dependsOnTaskId: dealDependencyModel.dependsOnTaskId,
        })
        .from(dealDependencyModel)
        .where(eq(dealDependencyModel.workspaceId, workspaceId))
        .innerJoin(
          dealTaskModel,
          and(
            eq(dealTaskModel.id, dealDependencyModel.taskId),
            eq(dealTaskModel.dealId, dealId),
          ),
        )
      if (
        edges.filter((e) => e.taskId === taskId).length >=
        MAX_DEAL_TASK_DEPENDENCIES_PER_TASK
      ) {
        throw validationException(
          "dependsOnTaskId",
          `A task waits on at most ${MAX_DEAL_TASK_DEPENDENCIES_PER_TASK} tasks.`,
          { reason: "tooManyDependencies" },
        )
      }
      if (
        edges.some(
          (e) => e.taskId === taskId && e.dependsOnTaskId === dependsOnTaskId,
        )
      ) {
        throw validationException(
          "dependsOnTaskId",
          "That dependency already exists.",
          { reason: "dependencyExists" },
        )
      }
      if (this.reaches({ edges, from: dependsOnTaskId, to: taskId })) {
        throw validationException(
          "dependsOnTaskId",
          "That dependency would create a cycle.",
          { reason: "dependencyCycle" },
        )
      }
      const [inserted] = await tx
        .insert(dealDependencyModel)
        .values({ id: createId(), workspaceId, taskId, dependsOnTaskId })
        .returning()
      return inserted
    })
    await this.audit("deal.task.dependency.add", row.id)
    return row
  }

  async removeDependency(props: {
    workspaceId: string
    dealId: string
    taskId: string
    dependsOnTaskId: string
    viewer?: DealViewer | null
  }): Promise<{ removed: boolean }> {
    const { workspaceId, dealId, taskId, dependsOnTaskId, viewer } = props
    await this.findOrFail({ workspaceId, dealId, taskId, viewer })
    const deleted = await db
      .delete(dealDependencyModel)
      .where(
        and(
          eq(dealDependencyModel.workspaceId, workspaceId),
          eq(dealDependencyModel.taskId, taskId),
          eq(dealDependencyModel.dependsOnTaskId, dependsOnTaskId),
        ),
      )
      .returning({ id: dealDependencyModel.id })
    if (deleted.length > 0) {
      await this.audit("deal.task.dependency.remove", deleted[0].id)
    }
    return { removed: deleted.length > 0 }
  }

  /**
   * Overdue scanner: claim every open task past its due date that was not
   * notified yet (`FOR UPDATE SKIP LOCKED`, so two workers never claim the
   * same row), stamp `overdueNotifiedAt`, then emit `taskOverdue` per row. A
   * failed emit is logged, never retried: the stamp is the truth.
   */
  async claimOverdue(
    props: { now?: Date; limit?: number } = {},
  ): Promise<{ scanned: number; emitted: number }> {
    const now = props.now ?? new Date()
    const limit = Math.min(Math.max(props.limit ?? 200, 1), 1000)
    const claimed = await db.transaction(async (tx) => {
      // Only tasks of OPEN deals: a won/lost deal's leftover tasks never ping.
      const candidates = await tx.execute<{ id: string }>(sql`
        select t."id" from "DealTask" t
        join "Deal" d on d."id" = t."dealId" and d."status" = 'open'
        where t."status" = 'open' and t."overdueNotifiedAt" is null and t."dueAt" < ${now}
        order by t."dueAt" asc
        limit ${limit}
        for update of t skip locked
      `)
      const ids = candidates.rows.map((r) => String(r.id))
      if (ids.length === 0) {
        return [] as DealTaskModel[]
      }
      return await tx
        .update(dealTaskModel)
        .set({ overdueNotifiedAt: now })
        .where(inArray(dealTaskModel.id, ids))
        .returning()
    })
    let emitted = 0
    for (const task of claimed) {
      try {
        const deal = await dealService.findOrFail({
          workspaceId: task.workspaceId,
          id: task.dealId,
        })
        await this.emitFor(deal, task, emitDealTaskOverdue, {})
        emitted++
      } catch (error) {
        logger.warn(
          { error, taskId: task.id },
          "deal-task: overdue emit failed; the claim stands",
        )
      }
    }
    return { scanned: claimed.length, emitted }
  }

  // ---- internals ----------------------------------------------------------

  private async insertInTx(props: {
    tx: DatabaseClient
    workspaceId: string
    dealId: string
    values: {
      title: string
      description: string | null
      dueAt: Date | null
      assigneeId: string | null
      templateId: string | null
    }
    actorId: string | null
  }): Promise<DealTaskModel> {
    const { tx, workspaceId, dealId, values, actorId } = props
    const [row] = await tx
      .insert(dealTaskModel)
      .values({
        id: createId(),
        workspaceId,
        dealId,
        title: values.title,
        description: values.description,
        status: "open",
        dueAt: values.dueAt,
        assigneeId: values.assigneeId,
        templateId: values.templateId,
        createdById: actorId,
      })
      .returning()
    await this.recordActivity({
      tx,
      dealId,
      type: "taskCreated",
      actorId,
      payload: { taskId: row.id, title: row.title },
    })
    return row
  }

  /**
   * Instantiate a stage's templates for a deal. Runs AFTER the move/create
   * transaction committed (see `deal/stage-hooks.ts`), one transaction per
   * template, `ON CONFLICT (dealId, templateId) DO NOTHING`: re-entering a
   * stage never duplicates its tasks, and a template failure never un-does
   * the stage move. Emits only for rows actually inserted.
   */
  async instantiateForStage(props: {
    workspaceId: string
    deal: DealModel
    stageId: string
    actorId: string | null
    templates: {
      id: string
      title: string
      description: string | null
      dueInDays: number | null
      assignToOwner: boolean
      assigneeId: string | null
    }[]
  }): Promise<{ created: DealTaskModel[] }> {
    const { workspaceId, actorId } = props
    // The caller's `deal` is the row its own transaction returned; the owner
    // may have changed since (skeptic MEDIUM). Re-read once, here.
    const deal = await dealService.findOrFail({
      workspaceId,
      id: props.deal.id,
    })
    const created: DealTaskModel[] = []
    for (const template of props.templates) {
      const assigneeId = template.assignToOwner
        ? (deal.ownerId ?? null)
        : (template.assigneeId ?? null)
      const dueAt =
        template.dueInDays === null
          ? null
          : new Date(Date.now() + template.dueInDays * 86_400_000)
      const row = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(dealTaskModel)
          .values({
            id: createId(),
            workspaceId,
            dealId: deal.id,
            title: template.title,
            description: template.description,
            status: "open",
            dueAt,
            assigneeId,
            templateId: template.id,
            createdById: actorId,
          })
          .onConflictDoNothing({
            target: [dealTaskModel.dealId, dealTaskModel.templateId],
            where: sql`${dealTaskModel.templateId} is not null`,
          })
          .returning()
        if (!inserted) {
          return null
        }
        await this.recordActivity({
          tx,
          dealId: deal.id,
          type: "taskCreated",
          actorId,
          payload: {
            taskId: inserted.id,
            title: inserted.title,
            templateId: template.id,
          },
        })
        return inserted
      })
      if (!row) {
        continue
      }
      created.push(row)
      await this.emitFor(deal, row, emitDealTaskCreated, {})
      if (row.assigneeId) {
        await this.emitFor(deal, row, emitDealTaskAssigned, {
          previousAssigneeId: null,
        })
        await this.notifyAssignee(deal, row, actorId)
      }
    }
    return { created }
  }

  /**
   * Open blockers of a task, read `FOR SHARE` inside the completing
   * transaction: a concurrent `reopen()` of a blocker (an UPDATE on that row)
   * waits until this transaction ends, so the check and the status-pinned
   * UPDATE see one consistent graph (skeptic HIGH, s192).
   */
  private async openBlockers(props: {
    taskId: string
    tx: DatabaseClient
  }): Promise<string[]> {
    const rows = await props.tx
      .select({ id: dealTaskModel.id })
      .from(dealDependencyModel)
      .innerJoin(
        dealTaskModel,
        eq(dealTaskModel.id, dealDependencyModel.dependsOnTaskId),
      )
      .where(
        and(
          eq(dealDependencyModel.taskId, props.taskId),
          eq(dealTaskModel.status, "open"),
        ),
      )
      .for("share", { of: dealTaskModel })
    return rows.map((r) => r.id)
  }

  /**
   * Bounded BFS: does `from` reach `to` along `dependsOn` edges? The visited
   * set makes it O(E); the step cap is the hard stop for a caller-supplied
   * graph the caps somehow let through. Public for the cap test.
   */
  reaches(props: {
    edges: { taskId: string; dependsOnTaskId: string }[]
    from: string
    to: string
  }): boolean {
    const { edges, from, to } = props
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
            "dependsOnTaskId",
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

  private async recordActivity(props: {
    tx: DatabaseClient
    dealId: string
    type: "taskCreated" | "taskCompleted"
    actorId: string | null
    payload: Record<string, unknown>
  }): Promise<void> {
    await props.tx.insert(dealActivityModel).values({
      id: createId(),
      dealId: props.dealId,
      type: props.type,
      actorId: props.actorId,
      // jsonb: written explicitly, never by a drizzle default (AGENTS.md)
      payload: props.payload,
    })
  }

  private async emitFor<Extra extends Record<string, unknown>>(
    deal: DealModel,
    task: DealTaskModel,
    emit: (
      workspaceId: string,
      contactId: string,
      metadata: DealTaskEventMetadata & Extra,
    ) => Promise<void>,
    extra: Extra,
  ): Promise<void> {
    if (!deal.contactId) {
      return
    }
    try {
      await emit(deal.workspaceId, deal.contactId, {
        ...dealEventMetadata(deal),
        taskId: task.id,
        taskTitle: task.title,
        taskDueAt: task.dueAt?.toISOString() ?? null,
        assigneeId: task.assigneeId,
        templateId: task.templateId,
        ...extra,
      })
    } catch (error) {
      logger.warn({ error, taskId: task.id }, "deal-task: event emit failed")
    }
  }

  /**
   * The assignee's own notification (s194): beside `emitFor`, never inside
   * it, so a contact-less deal still notifies (events route by contact,
   * notifications by user). Self-assignment is silent, like a conversation
   * you assign to yourself. Never throws: a delivery failure is logged.
   */
  private async notifyAssignee(
    deal: DealModel,
    task: DealTaskModel,
    actorId: string | null,
  ): Promise<void> {
    if (!task.assigneeId || task.assigneeId === actorId) {
      return
    }
    try {
      await notificationService.notify({
        workspaceId: deal.workspaceId,
        userId: task.assigneeId,
        type: "taskAssigned",
        dealId: deal.id,
        taskId: task.id,
        payload: {
          pipelineId: deal.pipelineId,
          dealTitle: deal.title,
          taskTitle: task.title,
          actorId,
        },
      })
    } catch (error) {
      logger.warn({ error, taskId: task.id }, "deal-task: notify failed")
    }
  }

  private resolveAssignee(props: {
    workspaceId: string
    assigneeId: string | null | undefined
    tx: DatabaseClient
  }): Promise<string | null> {
    return resolveWorkspaceMember({
      workspaceId: props.workspaceId,
      userId: props.assigneeId,
      tx: props.tx,
      field: "assigneeId",
      role: "Assignee",
    })
  }

  private parseData(data: DealTaskData): {
    title: string
    description: string | null
    dueAt: Date | null
  } {
    if (data === null || typeof data !== "object") {
      throw validationException("title", "Task data is required.")
    }
    return {
      title: this.parseTitle(data.title),
      description: this.parseDescription(data.description),
      dueAt: this.parseDueAt(data.dueAt),
    }
  }

  private parseTitle(value: unknown): string {
    return parseRequiredText({
      value,
      field: "title",
      max: MAX_DEAL_TASK_TITLE_LENGTH,
    })
  }

  private parseDescription(value: unknown): string | null {
    return parseOptionalText({
      value,
      field: "description",
      max: MAX_DEAL_TASK_DESCRIPTION_LENGTH,
    })
  }

  private parseDueAt(value: unknown): Date | null {
    return parseDateOrNull(value, "dueAt")
  }
}

export const dealTaskService = new DealTaskService()
