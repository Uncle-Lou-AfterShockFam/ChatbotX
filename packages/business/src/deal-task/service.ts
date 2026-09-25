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
import {
  assertStartNotAfterDue,
  downstreamOpen,
  edgeRefusal,
  reaches,
  sameInstant,
  withSchedule,
} from "./schedule"

export { DEPENDENCY_WALK_STEP_CAP } from "./schedule"

const TASK_NOT_FOUND = "Task not found"
const DAY_MS = 86_400_000
const EDGE_REFUSAL_MESSAGES = {
  tooManyDependencies: `A task waits on at most ${MAX_DEAL_TASK_DEPENDENCIES_PER_TASK} tasks.`,
  dependencyExists: "That dependency already exists.",
  dependencyCycle: "That dependency would create a cycle.",
} as const

export type DealTaskData = {
  title: string
  description?: string | null
  assigneeId?: string | null
  startAt?: Date | string | null
  dueAt?: Date | string | null
  templateId?: string | null
}
export type DealTaskUpdateData = Partial<
  Pick<
    DealTaskData,
    "title" | "description" | "assigneeId" | "startAt" | "dueAt"
  >
> & {
  /**
   * When the due date moves, move every OPEN task downstream of this one
   * (along DealDependency edges) by the same delta, in the same transaction.
   */
  shiftSuccessors?: boolean
}
export type DealTaskWithBlockers = DealTaskModel & {
  /** Ids of OPEN tasks this one waits on (derived, never stored). */
  blockedBy: string[]
  /** Every task this one waits on, open or done (the stored edges). */
  dependsOn: string[]
  /**
   * Where the timeline bar starts: `startAt`, else the latest due date among
   * the tasks it waits on, else `createdAt` (derived, never stored).
   */
  effectiveStart: Date
  /** Tasks it waits on whose due date falls after this task's start. */
  conflicts: string[]
}
/** A stage template being instantiated (the `listForStage` row shape). */
export type InstantiableTemplate = {
  id: string
  title: string
  description: string | null
  startInDays: number | null
  dueInDays: number | null
  assignToOwner: boolean
  assigneeId: string | null
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
    /** `FOR UPDATE`: the caller derives its write from this row (s197). */
    forUpdate?: boolean
  }): Promise<DealTaskModel> {
    const { workspaceId, dealId, taskId, viewer, tx = db } = props
    if (viewer) {
      await dealService.findOrFail({ workspaceId, id: dealId, viewer, tx })
    }
    const query = tx
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
    const [task] = props.forUpdate ? await query.for("update") : await query
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
    return withSchedule(tasks, deps)
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
    assertStartNotAfterDue(parsed.startAt, parsed.dueAt)
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
   * Title / description / assignee / start / due date. Only the assignee
   * change is an event (`taskAssigned`); a due date moved into the future
   * re-arms the overdue scanner. With `shiftSuccessors` a due-date move is
   * applied to every open downstream task too (`shifted` lists them).
   */
  async update(props: {
    workspaceId: string
    dealId: string
    taskId: string
    data: DealTaskUpdateData
    actorId?: string | null
    viewer?: DealViewer | null
  }): Promise<DealTaskModel & { shifted: string[] }> {
    const { workspaceId, dealId, taskId, data, viewer } = props
    const set: Partial<typeof dealTaskModel.$inferInsert> = {}
    const datesChange = data.startAt !== undefined || data.dueAt !== undefined
    const result = await db.transaction(async (tx) => {
      // A successor shift takes the deal graph lock FIRST (lock, then rows:
      // the order of addDependency / complete), and a date change reads its
      // row FOR UPDATE: the start <= due check and the shift delta are then
      // derived from the row this write replaces, never a stale read (codex
      // probe, s197: a concurrent date update between read and lock skewed
      // the delta and could leave start > due).
      if (data.shiftSuccessors && data.dueAt !== undefined) {
        await lockDealGraph(tx, dealId)
      }
      const current = await this.findOrFail({
        workspaceId,
        dealId,
        taskId,
        viewer,
        tx,
        forUpdate: datesChange,
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
      if (data.startAt !== undefined) {
        const startAt = this.parseStartAt(data.startAt)
        if (!sameInstant(startAt, current.startAt)) {
          set.startAt = startAt
        }
      }
      if (data.dueAt !== undefined) {
        const dueAt = this.parseDueAt(data.dueAt)
        if (!sameInstant(dueAt, current.dueAt)) {
          set.dueAt = dueAt
          if (dueAt && dueAt.getTime() > Date.now()) {
            set.overdueNotifiedAt = null
          }
        }
      }
      assertStartNotAfterDue(
        set.startAt === undefined ? current.startAt : set.startAt,
        set.dueAt === undefined ? current.dueAt : set.dueAt,
      )
      if (Object.keys(set).length === 0) {
        return {
          task: current,
          changed: false,
          previousAssigneeId,
          shifted: [],
        }
      }
      const deltaMs =
        data.shiftSuccessors && set.dueAt && current.dueAt
          ? set.dueAt.getTime() - current.dueAt.getTime()
          : 0
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
        return {
          task: again,
          changed: false,
          previousAssigneeId: undefined,
          shifted: [],
        }
      }
      const shifted =
        deltaMs === 0
          ? []
          : await this.shiftSuccessorsInTx({ tx, dealId, taskId, deltaMs })
      const deal = await dealService.findOrFail({ workspaceId, id: dealId, tx })
      return { task: updated, changed: true, previousAssigneeId, deal, shifted }
    })
    if (!result.changed) {
      return { ...result.task, shifted: [] }
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
    return { ...result.task, shifted: result.shifted }
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
        // The graph lock before the FOR SHARE blocker read: a successor
        // shift holds it while locking every task of the deal, so without it
        // the two lock rows in opposite orders and deadlock (codex, s197).
        await lockDealGraph(tx, dealId)
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
      await lockDealGraph(tx, dealId)
      await this.findOrFail({ workspaceId, dealId, taskId, viewer, tx })
      await this.findOrFail({
        workspaceId,
        dealId,
        taskId: dependsOnTaskId,
        tx,
      })
      const edges = await this.dealEdges(tx, workspaceId, dealId)
      const refusal = edgeRefusal({
        edges,
        taskId,
        dependsOnTaskId,
        cap: MAX_DEAL_TASK_DEPENDENCIES_PER_TASK,
      })
      if (refusal) {
        throw validationException(
          "dependsOnTaskId",
          EDGE_REFUSAL_MESSAGES[refusal],
          { reason: refusal },
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
      startAt: Date | null
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
        startAt: values.startAt,
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
   * the stage move. Emits only for rows actually inserted. Template edges are
   * then copied onto the deal (`copyTemplateEdges`).
   */
  async instantiateForStage(props: {
    workspaceId: string
    deal: DealModel
    stageId: string
    actorId: string | null
    templates: InstantiableTemplate[]
  }): Promise<{ created: DealTaskModel[]; edges: number }> {
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
      const now = Date.now()
      const startAt =
        template.startInDays === null
          ? null
          : new Date(now + template.startInDays * DAY_MS)
      const dueAt =
        template.dueInDays === null
          ? null
          : new Date(now + template.dueInDays * DAY_MS)
      let row: DealTaskModel | null
      try {
        row = await this.insertFromTemplate({
          workspaceId,
          dealId: deal.id,
          template,
          startAt,
          dueAt,
          assigneeId,
          actorId,
        })
      } catch (error) {
        // A template (or its assignee) deleted since `listForStage` fails
        // its FK: skip that one, keep the rest and the edge copy (probe, s197).
        logger.warn(
          { error, dealId: deal.id, templateId: template.id },
          "deal-task: template instantiation failed; skipped",
        )
        continue
      }
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
    let edges = 0
    try {
      edges = await this.copyTemplateEdges({
        workspaceId,
        dealId: deal.id,
        templates: props.templates,
        createdIds: new Set(created.map((t) => t.id)),
      })
    } catch (error) {
      // The tasks stand without their chain; a stage move never fails on it.
      logger.warn(
        { error, dealId: deal.id },
        "deal-task: template edge copy failed",
      )
    }
    return { created, edges }
  }

  /** One template's task + activity in one transaction; null = already instantiated. */
  private async insertFromTemplate(props: {
    workspaceId: string
    dealId: string
    template: InstantiableTemplate
    startAt: Date | null
    dueAt: Date | null
    assigneeId: string | null
    actorId: string | null
  }): Promise<DealTaskModel | null> {
    const {
      workspaceId,
      dealId,
      template,
      startAt,
      dueAt,
      assigneeId,
      actorId,
    } = props
    return await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(dealTaskModel)
        .values({
          id: createId(),
          workspaceId,
          dealId,
          title: template.title,
          description: template.description,
          status: "open",
          startAt,
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
        dealId,
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
  }

  /**
   * Copy the stage templates' edges onto the deal as DealDependency rows
   * between their instances. Only an edge touching a task THIS entry created
   * is copied, so a re-entry (nothing created) is a no-op and an edge the
   * user removed by hand stays removed. Each copy passes the same cap and
   * cycle checks as `addDependency` under the same per-deal lock; an edge
   * that fails them (a hand-made reverse edge, say) is skipped and logged.
   */
  private async copyTemplateEdges(props: {
    workspaceId: string
    dealId: string
    templates: InstantiableTemplate[]
    createdIds: Set<string>
  }): Promise<number> {
    const { workspaceId, dealId, templates, createdIds } = props
    const wanted = templates.flatMap((t) =>
      t.dependsOn.map((dependsOn) => ({ from: t.id, to: dependsOn })),
    )
    if (wanted.length === 0 || createdIds.size === 0) {
      return 0
    }
    return await db.transaction(async (tx) => {
      await lockDealGraph(tx, dealId)
      const instances = await tx
        .select({
          id: dealTaskModel.id,
          templateId: dealTaskModel.templateId,
          status: dealTaskModel.status,
        })
        .from(dealTaskModel)
        .where(
          and(
            eq(dealTaskModel.dealId, dealId),
            inArray(
              dealTaskModel.templateId,
              templates.map((t) => t.id),
            ),
          ),
        )
      const taskByTemplate = new Map(
        instances.map((i) => [i.templateId as string, i.id]),
      )
      // a DONE dependent from an earlier entry never gains a blocker
      const done = new Set(
        instances.filter((i) => i.status === "done").map((i) => i.id),
      )
      const edges = await this.dealEdges(tx, workspaceId, dealId)
      let inserted = 0
      for (const { from, to } of wanted) {
        const taskId = taskByTemplate.get(from)
        const dependsOnTaskId = taskByTemplate.get(to)
        if (
          !(
            taskId &&
            dependsOnTaskId &&
            !done.has(taskId) &&
            (createdIds.has(taskId) || createdIds.has(dependsOnTaskId))
          )
        ) {
          continue
        }
        const skip = edgeRefusal({
          edges,
          taskId,
          dependsOnTaskId,
          cap: MAX_DEAL_TASK_DEPENDENCIES_PER_TASK,
        })
        if (skip) {
          logger.info(
            { dealId, taskId, dependsOnTaskId, reason: skip },
            "deal-task: template edge skipped",
          )
          continue
        }
        const [row] = await tx
          .insert(dealDependencyModel)
          .values({ id: createId(), workspaceId, taskId, dependsOnTaskId })
          .onConflictDoNothing()
          .returning({ id: dealDependencyModel.id })
        if (row) {
          edges.push({ taskId, dependsOnTaskId })
          inserted++
        }
      }
      return inserted
    })
  }

  /**
   * Move every OPEN task downstream of `taskId` by `deltaMs` (start and due,
   * whichever is set). Runs inside the caller's transaction under the deal
   * graph lock; a visited set makes a diamond move each task once, and the
   * walk is bounded by the deal's task cap. Done tasks keep their dates and
   * do not carry the shift further (their successors still move if another
   * open path reaches them).
   */
  private async shiftSuccessorsInTx(props: {
    tx: DatabaseClient
    dealId: string
    taskId: string
    deltaMs: number
  }): Promise<string[]> {
    const { tx, dealId, taskId, deltaMs } = props
    const tasks = await tx
      .select({
        id: dealTaskModel.id,
        status: dealTaskModel.status,
        startAt: dealTaskModel.startAt,
        dueAt: dealTaskModel.dueAt,
      })
      .from(dealTaskModel)
      .where(eq(dealTaskModel.dealId, dealId))
      .for("update")
    const edges = await tx
      .select({
        taskId: dealDependencyModel.taskId,
        dependsOnTaskId: dealDependencyModel.dependsOnTaskId,
      })
      .from(dealDependencyModel)
      .where(
        inArray(
          dealDependencyModel.taskId,
          tasks.map((t) => t.id),
        ),
      )
    const ids = downstreamOpen({ tasks, edges, from: taskId })
    const shifted: string[] = []
    const now = Date.now()
    for (const id of ids) {
      const task = tasks.find((t) => t.id === id)
      if (!(task && (task.startAt || task.dueAt))) {
        continue
      }
      const dueAt = task.dueAt ? new Date(task.dueAt.getTime() + deltaMs) : null
      await tx
        .update(dealTaskModel)
        .set({
          startAt: task.startAt
            ? new Date(task.startAt.getTime() + deltaMs)
            : null,
          dueAt,
          ...(dueAt && dueAt.getTime() > now
            ? { overdueNotifiedAt: null }
            : {}),
        })
        .where(and(eq(dealTaskModel.id, id), eq(dealTaskModel.status, "open")))
      shifted.push(id)
    }
    return shifted
  }

  /** Every DealDependency edge of one deal (the graph the checks walk). */
  private async dealEdges(
    tx: DatabaseClient,
    workspaceId: string,
    dealId: string,
  ): Promise<{ taskId: string; dependsOnTaskId: string }[]> {
    return await tx
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
    return reaches(props)
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
    startAt: Date | null
    dueAt: Date | null
  } {
    if (data === null || typeof data !== "object") {
      throw validationException("title", "Task data is required.")
    }
    return {
      title: this.parseTitle(data.title),
      description: this.parseDescription(data.description),
      startAt: this.parseStartAt(data.startAt),
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

  private parseStartAt(value: unknown): Date | null {
    return parseDateOrNull(value, "startAt")
  }
}

/**
 * The per-deal graph lock: every writer of a deal's edges, and a successor
 * shift, takes it first so a check and its write see one graph.
 */
async function lockDealGraph(
  tx: DatabaseClient,
  dealId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`deal-deps:${dealId}`}))`,
  )
}

export const dealTaskService = new DealTaskService()
