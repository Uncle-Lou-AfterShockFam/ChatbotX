import {
  and,
  count,
  type DatabaseClient,
  db,
  eq,
  inArray,
  isNotNull,
  lt,
  lte,
  sql,
} from "@chatbotx.io/database/client"
import {
  type SmartDelayStatus,
  type SmartDelayType,
  smartDelayStatuses,
  smartDelayTypes,
} from "@chatbotx.io/database/partials"
import {
  contactInboxModel,
  contactOnSmartDelayModel,
} from "@chatbotx.io/database/schema"
import { BaseService } from "../base.service"

export type SmartDelayRow = Omit<
  typeof contactOnSmartDelayModel.$inferSelect,
  "status" | "type"
> & {
  status: SmartDelayStatus
  type: SmartDelayType
}
export type SmartDelayInsert = typeof contactOnSmartDelayModel.$inferInsert
export type SmartDelayStepCountRow = {
  stepId: string
  status: SmartDelayStatus
  total: number
}

const toSmartDelayRow = (
  row: typeof contactOnSmartDelayModel.$inferSelect,
): SmartDelayRow => ({
  ...row,
  status: smartDelayStatuses.parse(row.status),
  type: smartDelayTypes.parse(row.type),
})

// running too: a freeze / stop must also cancel a claimed row, or the
// stuck-running sweep would later resurrect it for a stopped contact. The
// in-flight run's claimCheck / finishClaimedRun CAS then just fails.
const activeInWorkspace = (workspaceId: string) =>
  and(
    eq(contactOnSmartDelayModel.workspaceId, workspaceId),
    inArray(contactOnSmartDelayModel.status, [
      smartDelayStatuses.enum.pending,
      smartDelayStatuses.enum.scheduled,
      smartDelayStatuses.enum.running,
    ]),
  )

/** Needs the `ContactInbox` join on `contactInboxId`. */
const activeForContacts = (workspaceId: string, contactIds: string[]) =>
  and(
    activeInWorkspace(workspaceId),
    inArray(contactInboxModel.contactId, contactIds),
  )

/** Claims a resume may take (initial + retries + recoveries) before the row is `failed`. */
export const MAX_RESUME_CLAIMS = 3

class SmartDelayService extends BaseService {
  async create(props: {
    tx?: DatabaseClient
    data: SmartDelayInsert
  }): Promise<void> {
    const { tx = db, data } = props
    await tx.insert(contactOnSmartDelayModel).values(data)
  }

  async upsertFollowUp(props: {
    tx?: DatabaseClient
    data: SmartDelayInsert
  }): Promise<SmartDelayRow> {
    const { tx = db, data } = props
    const now = new Date()
    const [row] = await tx
      .insert(contactOnSmartDelayModel)
      .values(data)
      .onConflictDoUpdate({
        target: [
          contactOnSmartDelayModel.workspaceId,
          contactOnSmartDelayModel.contactInboxId,
          contactOnSmartDelayModel.flowId,
          contactOnSmartDelayModel.stepId,
        ],
        targetWhere: sql`${contactOnSmartDelayModel.status} NOT IN ('completed', 'failed', 'canceled') AND ${contactOnSmartDelayModel.type} = 'followUp'`,
        set: {
          conversationId: data.conversationId,
          appointmentId: data.appointmentId,
          createdAt: now,
          flowVersionId: data.flowVersionId,
          metadata: data.metadata,
          nodeId: data.nodeId,
          status: smartDelayStatuses.enum.pending,
          triggerAt: data.triggerAt,
        },
      })
      .returning()

    if (!row) {
      throw new Error("Failed to upsert follow-up smart delay")
    }

    return toSmartDelayRow(row)
  }

  /**
   * Mark a freshly written row scheduled before its immediate job is enqueued:
   * a pending -> scheduled CAS on the caller's own triggerAt. False = not
   * marked, do not enqueue. A miss means the row moved on since the caller
   * wrote it, and every such mover owns what happens next:
   * - canceled (company stop / workspace freeze) or completed: an unguarded
   *   write would resurrect it and the job would run for a stopped contact;
   * - claimed by its event (waitForEvent): its timeout must not run too;
   * - claimed by the scanner (claimDueRows), which enqueues it itself;
   * - re-armed by a newer upsertFollowUp (a different triggerAt), whose own
   *   mark enqueues the job at the NEW time instead of this stale one.
   */
  async markScheduled(props: {
    tx?: DatabaseClient
    id: string
    triggerAt: Date
  }): Promise<boolean> {
    const { tx = db, id, triggerAt } = props
    const rows = await tx
      .update(contactOnSmartDelayModel)
      .set({ status: smartDelayStatuses.enum.scheduled })
      .where(
        and(
          eq(contactOnSmartDelayModel.id, id),
          eq(contactOnSmartDelayModel.status, smartDelayStatuses.enum.pending),
          eq(contactOnSmartDelayModel.triggerAt, triggerAt),
        ),
      )
      .returning({ id: contactOnSmartDelayModel.id })
    return rows.length > 0
  }

  async markCompleted(props: {
    tx?: DatabaseClient
    id: string
  }): Promise<void> {
    await this.markStatus({
      tx: props.tx,
      id: props.id,
      status: smartDelayStatuses.enum.completed,
    })
  }

  async markCanceled(props: {
    tx?: DatabaseClient
    id: string
  }): Promise<void> {
    await this.markStatus({
      tx: props.tx,
      id: props.id,
      status: smartDelayStatuses.enum.canceled,
    })
  }

  async findById(props: {
    tx?: DatabaseClient
    id: string
  }): Promise<SmartDelayRow | null> {
    const { tx = db, id } = props
    const row = await tx.query.contactOnSmartDelayModel.findFirst({
      where: { id },
    })
    return row ? toSmartDelayRow(row) : null
  }

  async countByFlowStep(props: {
    tx?: DatabaseClient
    workspaceId: string
    flowId: string
  }): Promise<SmartDelayStepCountRow[]> {
    const { tx = db, workspaceId, flowId } = props
    const rows = await tx
      .select({
        stepId: contactOnSmartDelayModel.stepId,
        status: contactOnSmartDelayModel.status,
        total: count(),
      })
      .from(contactOnSmartDelayModel)
      .where(
        and(
          eq(contactOnSmartDelayModel.workspaceId, workspaceId),
          eq(contactOnSmartDelayModel.flowId, flowId),
          isNotNull(contactOnSmartDelayModel.stepId),
        ),
      )
      .groupBy(contactOnSmartDelayModel.stepId, contactOnSmartDelayModel.status)

    return rows.flatMap((row) =>
      row.stepId
        ? [
            {
              stepId: row.stepId,
              status: smartDelayStatuses.parse(row.status),
              total: Number(row.total),
            },
          ]
        : [],
    )
  }

  // Claims one bounded batch: this table can grow by hundreds of thousands of
  // rows per minute, so the claim must never load the whole backlog at once.
  // FOR UPDATE SKIP LOCKED lets concurrent scanner runs split the backlog
  // instead of double-claiming the same rows.
  async claimDueRows(props: {
    tx?: DatabaseClient
    windowUntil: Date
    limit: number
  }): Promise<SmartDelayRow[]> {
    const { tx = db, windowUntil, limit } = props
    const dueRowIds = tx
      .select({ id: contactOnSmartDelayModel.id })
      .from(contactOnSmartDelayModel)
      .where(
        and(
          eq(contactOnSmartDelayModel.status, smartDelayStatuses.enum.pending),
          lte(contactOnSmartDelayModel.triggerAt, windowUntil),
        ),
      )
      .orderBy(contactOnSmartDelayModel.triggerAt)
      .limit(limit)
      .for("update", { skipLocked: true })

    const rows = await tx
      .update(contactOnSmartDelayModel)
      .set({ status: smartDelayStatuses.enum.scheduled })
      .where(
        and(
          eq(contactOnSmartDelayModel.status, smartDelayStatuses.enum.pending),
          inArray(contactOnSmartDelayModel.id, dueRowIds),
        ),
      )
      .returning()

    return rows.map(toSmartDelayRow)
  }

  /**
   * Terminal claim of a scheduled row (follow-up decided, terminal wait):
   * nothing runs after it, so the row goes straight to its final status.
   * `triggerAt` is the one the caller decided on: upsertFollowUp re-arms a
   * row in place (new triggerAt / createdAt), so a job that read the row
   * before a re-arm must not complete or cancel the newer arm with its stale
   * decision (a reply check against the old createdAt).
   */
  async claimForRun(props: {
    tx?: DatabaseClient
    id: string
    triggerAt: Date
    to: "completed" | "canceled"
  }): Promise<boolean> {
    const { tx = db, id, triggerAt, to } = props
    const rows = await tx
      .update(contactOnSmartDelayModel)
      .set({ status: smartDelayStatuses.enum[to] })
      .where(
        and(
          eq(contactOnSmartDelayModel.id, id),
          eq(
            contactOnSmartDelayModel.status,
            smartDelayStatuses.enum.scheduled,
          ),
          eq(contactOnSmartDelayModel.triggerAt, triggerAt),
        ),
      )
      .returning({ id: contactOnSmartDelayModel.id })

    return rows.length > 0
  }

  /**
   * Claim a scheduled row for a resume that RUNS the flow in-process (wait
   * node / waitForEvent timeout): scheduled -> running, generation + 1. The
   * returned row is what the caller owns (its nodeId is the edge to run and
   * its claimGeneration is the token for finish / requeue); null = lost the
   * CAS. Unlike the old completed-before-run claim, a worker that dies here
   * leaves a `running` row the scanner sweeps back to pending.
   */
  async claimRunning(props: {
    tx?: DatabaseClient
    id: string
  }): Promise<SmartDelayRow | null> {
    const { tx = db, id } = props
    const rows = await tx
      .update(contactOnSmartDelayModel)
      .set({
        status: smartDelayStatuses.enum.running,
        claimedAt: new Date(),
        claimGeneration: sql`${contactOnSmartDelayModel.claimGeneration} + 1`,
      })
      .where(
        and(
          eq(contactOnSmartDelayModel.id, id),
          eq(
            contactOnSmartDelayModel.status,
            smartDelayStatuses.enum.scheduled,
          ),
        ),
      )
      .returning()
    const row = rows[0]
    return row ? toSmartDelayRow(row) : null
  }

  /**
   * Every non-terminal `waitForEvent` row of a contact (the event carries a
   * contactId; the row stores the contactInbox). The caller matches the spec.
   */
  async findActiveWaitForEvent(props: {
    tx?: DatabaseClient
    workspaceId: string
    contactId: string
  }): Promise<SmartDelayRow[]> {
    const { tx = db, workspaceId, contactId } = props
    const rows = await tx
      .select({ row: contactOnSmartDelayModel })
      .from(contactOnSmartDelayModel)
      .innerJoin(
        contactInboxModel,
        eq(contactInboxModel.id, contactOnSmartDelayModel.contactInboxId),
      )
      .where(
        and(
          eq(contactOnSmartDelayModel.workspaceId, workspaceId),
          eq(contactOnSmartDelayModel.type, smartDelayTypes.enum.waitForEvent),
          inArray(contactOnSmartDelayModel.status, [
            smartDelayStatuses.enum.pending,
            smartDelayStatuses.enum.scheduled,
          ]),
          eq(contactInboxModel.contactId, contactId),
        ),
      )
      .orderBy(contactOnSmartDelayModel.createdAt)
    return rows.map(({ row }) => toSmartDelayRow(row))
  }

  /**
   * CAS for the event path: a `waitForEvent` row more than five minutes from
   * its timeout is still `pending` (no job yet), so unlike claimRunning this
   * claims from pending OR scheduled. Exactly one of event / timeout wins.
   * The SAME update re-points the row at its event edge and makes it due now,
   * so whatever resumes it later (this run, a retry, the stuck-running sweep
   * -> scanner -> timeout job) runs the edge that actually fired; no re-read.
   */
  async claimForEvent(props: {
    tx?: DatabaseClient
    id: string
  }): Promise<SmartDelayRow | null> {
    const { tx = db, id } = props
    const now = new Date()
    const rows = await tx
      .update(contactOnSmartDelayModel)
      .set({
        status: smartDelayStatuses.enum.running,
        claimedAt: now,
        claimGeneration: sql`${contactOnSmartDelayModel.claimGeneration} + 1`,
        nodeId: contactOnSmartDelayModel.eventNodeId,
        triggerAt: now,
      })
      .where(
        and(
          eq(contactOnSmartDelayModel.id, id),
          eq(contactOnSmartDelayModel.type, smartDelayTypes.enum.waitForEvent),
          inArray(contactOnSmartDelayModel.status, [
            smartDelayStatuses.enum.pending,
            smartDelayStatuses.enum.scheduled,
          ]),
        ),
      )
      .returning()
    const row = rows[0]
    return row ? toSmartDelayRow(row) : null
  }

  /**
   * Renew a running claim while its flow is still in flight, so the
   * stuck-running sweep (claimedAt older than the grace) only reclaims rows
   * whose worker actually stopped renewing, never a slow but alive run.
   * False = the claim is no longer current (swept / re-claimed): the caller
   * keeps running, its finish will then be refused and logged.
   */
  async heartbeatClaim(props: {
    tx?: DatabaseClient
    id: string
    generation: number
  }): Promise<boolean> {
    const { tx = db, id, generation } = props
    const rows = await tx
      .update(contactOnSmartDelayModel)
      .set({ claimedAt: new Date() })
      .where(
        and(
          eq(contactOnSmartDelayModel.id, id),
          eq(contactOnSmartDelayModel.status, smartDelayStatuses.enum.running),
          eq(contactOnSmartDelayModel.claimGeneration, generation),
        ),
      )
      .returning({ id: contactOnSmartDelayModel.id })
    return rows.length > 0
  }

  /**
   * The flow of a claimed (running) row finished: running -> completed, but
   * only for the generation that ran. A stale retry whose row was re-claimed
   * (and re-run) by another path cannot complete that newer run.
   */
  async finishClaimedRun(props: {
    tx?: DatabaseClient
    id: string
    generation: number
  }): Promise<boolean> {
    const { tx = db, id, generation } = props
    const rows = await tx
      .update(contactOnSmartDelayModel)
      .set({ status: smartDelayStatuses.enum.completed })
      .where(
        and(
          eq(contactOnSmartDelayModel.id, id),
          eq(contactOnSmartDelayModel.status, smartDelayStatuses.enum.running),
          eq(contactOnSmartDelayModel.claimGeneration, generation),
        ),
      )
      .returning({ id: contactOnSmartDelayModel.id })
    return rows.length > 0
  }

  /**
   * Re-open a running row whose flow failed: running -> scheduled, so the
   * BullMQ retry (or the recovery path) can claim and resume it again. The
   * generation CAS keeps a stale retry from resurrecting a row that a
   * different claim has since taken (or that a terminal path has closed).
   * The edge to resume on is already on the row (claimForEvent wrote it).
   *
   * The generation counts the claims so far. Past MAX_RESUME_CLAIMS the row
   * goes to `failed` instead: otherwise a permanently failing edge would
   * re-run (with every side effect before the failing step) on each retry,
   * then every ~10 min through the stuck-scheduled sweep, forever.
   * Returns the status written, or null when the CAS matched nothing.
   */
  async requeueClaimedRun(props: {
    tx?: DatabaseClient
    id: string
    generation: number
  }): Promise<"scheduled" | "failed" | null> {
    const { tx = db, id, generation } = props
    const to =
      generation >= MAX_RESUME_CLAIMS
        ? smartDelayStatuses.enum.failed
        : smartDelayStatuses.enum.scheduled
    const rows = await tx
      .update(contactOnSmartDelayModel)
      .set({ status: to })
      .where(
        and(
          eq(contactOnSmartDelayModel.id, id),
          eq(contactOnSmartDelayModel.status, smartDelayStatuses.enum.running),
          eq(contactOnSmartDelayModel.claimGeneration, generation),
        ),
      )
      .returning({ id: contactOnSmartDelayModel.id })

    return rows.length > 0 ? to : null
  }

  // Recovery input for the scanner: running rows whose claim is older than
  // the grace window = a worker died between the claim and the end of the
  // flow (the run itself is bounded well under the grace).
  async listStuckRunning(props: {
    tx?: DatabaseClient
    olderThan: Date
    limit: number
  }): Promise<
    Pick<SmartDelayRow, "id" | "triggerAt" | "nodeId" | "claimGeneration">[]
  > {
    const { tx = db, olderThan, limit } = props
    return await tx
      .select({
        id: contactOnSmartDelayModel.id,
        triggerAt: contactOnSmartDelayModel.triggerAt,
        // For the sweep log: which edge the recovered row will resume on.
        nodeId: contactOnSmartDelayModel.nodeId,
        claimGeneration: contactOnSmartDelayModel.claimGeneration,
      })
      .from(contactOnSmartDelayModel)
      .where(
        and(
          eq(contactOnSmartDelayModel.status, smartDelayStatuses.enum.running),
          lt(contactOnSmartDelayModel.claimedAt, olderThan),
        ),
      )
      .orderBy(contactOnSmartDelayModel.claimedAt)
      .limit(limit)
  }

  // CAS: only rows still running with a stale claim go back to pending, due
  // now, so the scanner's next claimDueRows re-enqueues them on the edge the
  // row already carries. A row whose run finished (or was requeued and
  // re-claimed) in the meantime has a newer claimedAt or status: untouched.
  // Returns how many rows were actually reset.
  async resetStuckRunning(props: {
    tx?: DatabaseClient
    ids: string[]
    claimedAtBefore: Date
  }): Promise<number> {
    const { tx = db, ids, claimedAtBefore } = props
    if (ids.length === 0) {
      return 0
    }
    const rows = await tx
      .update(contactOnSmartDelayModel)
      .set({
        status: smartDelayStatuses.enum.pending,
        triggerAt: new Date(),
      })
      .where(
        and(
          inArray(contactOnSmartDelayModel.id, ids),
          eq(contactOnSmartDelayModel.status, smartDelayStatuses.enum.running),
          lt(contactOnSmartDelayModel.claimedAt, claimedAtBefore),
        ),
      )
      .returning({ id: contactOnSmartDelayModel.id })
    return rows.length
  }

  // Recovery input for the scanner sweeper: scheduled rows whose wake-up never
  // ran (lost or stuck BullMQ job). Returns triggerAt too so the caller can
  // rebuild the deterministic jobId and remove the stale job BEFORE the row is
  // reset to pending — otherwise the re-add is dropped as a BullMQ duplicate.
  async listStuckScheduled(props: {
    tx?: DatabaseClient
    olderThan: Date
    limit: number
  }): Promise<Pick<SmartDelayRow, "id" | "triggerAt">[]> {
    const { tx = db, olderThan, limit } = props
    return await tx
      .select({
        id: contactOnSmartDelayModel.id,
        triggerAt: contactOnSmartDelayModel.triggerAt,
      })
      .from(contactOnSmartDelayModel)
      .where(
        and(
          eq(
            contactOnSmartDelayModel.status,
            smartDelayStatuses.enum.scheduled,
          ),
          lt(contactOnSmartDelayModel.triggerAt, olderThan),
        ),
      )
      .orderBy(contactOnSmartDelayModel.triggerAt)
      .limit(limit)
  }

  // CAS: only rows still 'scheduled' go back to pending. A concurrent resume
  // may complete/cancel a row between the caller's read and this write — an
  // unguarded reset would resurrect it and re-run its side effects.
  // `triggerAtBefore` (sweep path) additionally skips rows that were
  // rescheduled to a fresh future triggerAt in that same window; `triggerAt`
  // (one row's failed immediate enqueue) skips a row a newer follow-up arm
  // re-armed and scheduled meanwhile, whose own job is already queued.
  // Returns how many rows were actually reset.
  async resetToPending(props: {
    tx?: DatabaseClient
    ids: string[]
    triggerAtBefore?: Date
    triggerAt?: Date
  }): Promise<number> {
    const { tx = db, ids, triggerAtBefore, triggerAt } = props
    if (ids.length === 0) {
      return 0
    }

    const rows = await tx
      .update(contactOnSmartDelayModel)
      .set({ status: smartDelayStatuses.enum.pending })
      .where(
        and(
          inArray(contactOnSmartDelayModel.id, ids),
          eq(
            contactOnSmartDelayModel.status,
            smartDelayStatuses.enum.scheduled,
          ),
          triggerAtBefore
            ? lt(contactOnSmartDelayModel.triggerAt, triggerAtBefore)
            : undefined,
          triggerAt
            ? eq(contactOnSmartDelayModel.triggerAt, triggerAt)
            : undefined,
        ),
      )
      .returning({ id: contactOnSmartDelayModel.id })

    return rows.length
  }

  /**
   * Cancels one bounded batch of a workspace's still-firable rows (freeze /
   * teardown path) and returns `id` + `triggerAt` so the caller can rebuild the
   * deterministic jobId and drop the matching delayed BullMQ job.
   *
   * Cancelling the ROW is what actually stops the work: removing only the job
   * leaves the row `scheduled`, and the scanner's stuck-row sweeper would reset
   * it to `pending` and re-enqueue it on the next tick. `resetToPending` uses a
   * `status = 'scheduled'` CAS, so a `canceled` row can never be resurrected.
   *
   * Bounded + SKIP LOCKED: this table can hold hundreds of thousands of rows
   * per workspace, and a cancel that WAITS on row locks deadlocks against the
   * stuck-row sweeps and the contact-delete cascade (they lock in a different
   * order) and has no bound on a request path. A skipped row is still a
   * missed stop, so `runSmartDelayCancelLoop` re-checks with
   * `hasActiveForWorkspace` and retries the rows it stepped over.
   */
  async cancelActiveForWorkspace(props: {
    tx?: DatabaseClient
    workspaceId: string
    limit: number
  }): Promise<Pick<SmartDelayRow, "id" | "triggerAt">[]> {
    const { tx = db, workspaceId, limit } = props
    const activeRowIds = tx
      .select({ id: contactOnSmartDelayModel.id })
      .from(contactOnSmartDelayModel)
      .where(activeInWorkspace(workspaceId))
      .orderBy(contactOnSmartDelayModel.triggerAt)
      .limit(limit)
      .for("update", { skipLocked: true })

    return await tx
      .update(contactOnSmartDelayModel)
      .set({ status: smartDelayStatuses.enum.canceled })
      .where(inArray(contactOnSmartDelayModel.id, activeRowIds))
      .returning({
        id: contactOnSmartDelayModel.id,
        triggerAt: contactOnSmartDelayModel.triggerAt,
      })
  }

  /** Non-locking: does the workspace still have a firable row (one a cancel skipped)? */
  async hasActiveForWorkspace(props: {
    tx?: DatabaseClient
    workspaceId: string
  }): Promise<boolean> {
    const { tx = db, workspaceId } = props
    const rows = await tx
      .select({ id: contactOnSmartDelayModel.id })
      .from(contactOnSmartDelayModel)
      .where(activeInWorkspace(workspaceId))
      .limit(1)
    return rows.length > 0
  }

  /**
   * Company stop: cancel every still-firable row of the given contacts. Same
   * shape as `cancelActiveForWorkspace` (bounded, SKIP LOCKED + the loop's
   * re-check, the ROW is what stops the work); the row stores a contactInbox,
   * so the contact filter goes through `ContactInbox` exactly as
   * `findActiveWaitForEvent` does.
   */
  async cancelActiveForContacts(props: {
    tx?: DatabaseClient
    workspaceId: string
    contactIds: string[]
    limit: number
  }): Promise<Pick<SmartDelayRow, "id" | "triggerAt">[]> {
    const { tx = db, workspaceId, contactIds, limit } = props
    if (contactIds.length === 0) {
      return []
    }
    const activeRowIds = tx
      .select({ id: contactOnSmartDelayModel.id })
      .from(contactOnSmartDelayModel)
      .innerJoin(
        contactInboxModel,
        eq(contactInboxModel.id, contactOnSmartDelayModel.contactInboxId),
      )
      .where(activeForContacts(workspaceId, contactIds))
      .orderBy(contactOnSmartDelayModel.triggerAt)
      .limit(limit)
      .for("update", { skipLocked: true, of: contactOnSmartDelayModel })

    return await tx
      .update(contactOnSmartDelayModel)
      .set({ status: smartDelayStatuses.enum.canceled })
      .where(inArray(contactOnSmartDelayModel.id, activeRowIds))
      .returning({
        id: contactOnSmartDelayModel.id,
        triggerAt: contactOnSmartDelayModel.triggerAt,
      })
  }

  /** Non-locking twin of `cancelActiveForContacts`' filter. */
  async hasActiveForContacts(props: {
    tx?: DatabaseClient
    workspaceId: string
    contactIds: string[]
  }): Promise<boolean> {
    const { tx = db, workspaceId, contactIds } = props
    if (contactIds.length === 0) {
      return false
    }
    const rows = await tx
      .select({ id: contactOnSmartDelayModel.id })
      .from(contactOnSmartDelayModel)
      .innerJoin(
        contactInboxModel,
        eq(contactInboxModel.id, contactOnSmartDelayModel.contactInboxId),
      )
      .where(activeForContacts(workspaceId, contactIds))
      .limit(1)
    return rows.length > 0
  }

  private async markStatus(props: {
    tx?: DatabaseClient
    id: string
    status: SmartDelayStatus
  }): Promise<void> {
    const { tx = db, id, status } = props
    await tx
      .update(contactOnSmartDelayModel)
      .set({ status })
      .where(eq(contactOnSmartDelayModel.id, id))
  }
}

export const smartDelayService = new SmartDelayService()
