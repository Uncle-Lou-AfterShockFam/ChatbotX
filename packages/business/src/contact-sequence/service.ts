import {
  and,
  type DatabaseClient,
  db,
  eq,
  inArray,
  lte,
  sql,
  type Transaction,
} from "@chatbotx.io/database/client"
import {
  contactsOnSequenceModel,
  sequenceDispatchModel,
  sequenceModel,
  sequenceStepModel,
} from "@chatbotx.io/database/schema"
import {
  emitSequenceSubscribed,
  emitSequenceUnsubscribed,
} from "@chatbotx.io/events"
import {
  calculateNextRunAtFromStep,
  calculateNextValidSendTime,
  cancelPendingDispatches,
  enrollContactInSequence,
  enrollContactsInSequenceBulk,
  removeDispatchesFromSchedule,
  rescheduleDispatches,
  sequenceDispatchUtils,
} from "@chatbotx.io/sequence-scheduler"
import { BaseService } from "../base.service"
import { type ContactAccessScope, contactService } from "../contact/service"
import { notFoundException } from "../errors"
import { logger } from "../logger"

type DrizzleClient = DatabaseClient | Transaction
type DispatchToRemove = { id: string; bucket: number }
type RemovedEnrollment = {
  contactId: string
  sequenceId: string
  workspaceId: string
  contactInboxId?: string
}
type RemoveEnrollmentsResult = {
  dispatchesToRemove: DispatchToRemove[]
  removedEnrollments: RemovedEnrollment[]
}
type RemoveReason =
  | "subscription_removed"
  | "unsubscribed_via_flow"
  | "company_stopped"
  | "contact_replied"
  | "no_email_thread"

type RemoveContactSequencesForContactsParams = {
  client?: DrizzleClient
  contactIds: string[]
  removeFromSchedule?: boolean
  reason: RemoveReason
  sequenceIds: string[]
  useTransaction?: boolean
  workspaceId: string
  /**
   * The `ContactInbox` the flow-step unsubscribe (`removeContactSequence`)
   * has in scope. Only ever honored when `contactIds.length === 1` — see
   * `removeContactSequencesForContacts` — so it can never misattribute a
   * bulk removal (builder bulk unsubscribe, membership-diff) to one inbox.
   */
  contactInboxId?: string
}

type RemoveContactSequencesForContactParams = {
  client?: DrizzleClient
  contactId: string
  removeFromSchedule?: boolean
  reason: RemoveReason
  sequenceIds: string[]
  useTransaction?: boolean
  workspaceId: string
  contactInboxId?: string
}

type UpdateContactSequencesParams = {
  contactId: string
  sequenceIds: string[]
  workspaceId: string
}

const CHUNK_SIZE = 1000

async function getExistingEnrollments(
  workspaceId: string,
  contactIds: string[],
  sequenceIds: string[],
): Promise<Set<string>> {
  const enrollments = await db.query.contactsOnSequenceModel.findMany({
    where: {
      workspaceId,
      contactId: { in: contactIds },
      sequenceId: { in: sequenceIds },
    },
    columns: {
      contactId: true,
      sequenceId: true,
    },
  })

  return new Set<string>(
    enrollments.map((e) => `${e.contactId}-${e.sequenceId}`),
  )
}

function buildEnrollmentRecords(
  contacts: Array<{ id: string }>,
  sequenceIds: string[],
  existingKeys: Set<string>,
  nextRunAtMap: Map<string, { nextRunAt: Date; nextStepId: string | null }>,
  workspaceId: string,
  now: Date,
) {
  return contacts.flatMap((contact) =>
    sequenceIds
      .filter((sequenceId) => !existingKeys.has(`${contact.id}-${sequenceId}`))
      .map((sequenceId) => {
        const result = nextRunAtMap.get(sequenceId) ?? {
          nextRunAt: now,
          nextStepId: null,
        }
        return {
          contactId: contact.id,
          sequenceId,
          workspaceId,
          currentStep: 0,
          status: "active" as const,
          nextRunAt: result.nextRunAt,
          nextStepId: result.nextStepId,
          enrolledAt: now,
        }
      }),
  )
}
/** Outreach B-1 (owner s223b): an out-of-office pauses a sequence 14 days. */
export const OOO_PAUSE_MS = 14 * 24 * 60 * 60 * 1000

class ContactSequenceService extends BaseService {
  /**
   * Sequence ids come straight from the public API and are sequential
   * bigints — without this check a workspace-A token can enroll its
   * contacts into a workspace-B sequence just by guessing an id.
   */
  private async assertSequencesInWorkspace(props: {
    workspaceId: string
    sequenceIds: string[]
    tx?: DrizzleClient
  }): Promise<void> {
    const { workspaceId, sequenceIds, tx = db } = props
    if (sequenceIds.length === 0) {
      return
    }

    const owned = await tx.query.sequenceModel.findMany({
      where: { workspaceId, id: { in: sequenceIds } },
      columns: { id: true },
    })
    const ownedIds = new Set(owned.map((sequence) => sequence.id))
    const missing = sequenceIds.filter((id) => !ownedIds.has(id))
    if (missing.length > 0) {
      throw notFoundException("Sequence not found")
    }
  }

  async subscribeContacts(props: {
    workspaceId: string
    contactIds: string[]
    sequenceIds: string[]
    accessScope?: ContactAccessScope
  }): Promise<{ processedContactIds: string[]; skippedContactIds: string[] }> {
    const { workspaceId, contactIds, sequenceIds, accessScope } = props
    await this.assertSequencesInWorkspace({ workspaceId, sequenceIds })
    const now = new Date()
    const nextRunAtMap = await this.calculateNextRunAtBulk(
      workspaceId,
      sequenceIds,
      now,
      db,
    )

    const processedContactIds: string[] = []

    for (let offset = 0; offset < contactIds.length; offset += CHUNK_SIZE) {
      const contactIdChunk = contactIds.slice(offset, offset + CHUNK_SIZE)

      const contacts = await contactService.findManyByIds({
        workspaceId,
        ids: contactIdChunk,
        accessScope,
      })

      if (contacts.length === 0) {
        continue
      }
      processedContactIds.push(...contacts.map((contact) => contact.id))

      const existingKeys = await getExistingEnrollments(
        workspaceId,
        contacts.map((contact) => contact.id),
        sequenceIds,
      )

      const records = buildEnrollmentRecords(
        contacts,
        sequenceIds,
        existingKeys,
        nextRunAtMap,
        workspaceId,
        now,
      )

      if (records.length === 0) {
        continue
      }

      await enrollContactsInSequenceBulk({
        workspaceId,
        enrollments: records.map((record) => ({
          contactId: record.contactId,
          sequenceId: record.sequenceId,
          nextRunAt: record.nextRunAt,
          nextStepId: record.nextStepId,
        })),
        enrolledAt: now,
      })
    }

    const processedSet = new Set(processedContactIds)
    return {
      processedContactIds,
      skippedContactIds: contactIds.filter((id) => !processedSet.has(id)),
    }
  }
  /**
   * The flow-step `addContactTag`/`addContactSequence`-equivalent single-
   * contact subscription: unlike `subscribeContacts` (bulk, no per-enrollment
   * event), this emits `sequenceSubscribed` for the flow-step UI to react to,
   * matching the worker's original hand-rolled `nextRunAt` calculation
   * (`delayDays`/`delayMinutes` only — `delayUnit`/`specificDateTime` are
   * NOT honored here, carried over verbatim from the pre-existing worker
   * logic; unifying with `calculateNextRunAtFromStep`, which does honor
   * them, is a separate follow-up).
   */
  async subscribeFromFlow(props: {
    workspaceId: string
    contactId: string
    sequenceId: string
    contactInboxId: string
  }): Promise<void> {
    const { workspaceId, contactId, sequenceId, contactInboxId } = props

    const existing = await db.query.contactsOnSequenceModel.findFirst({
      where: { contactId, sequenceId, workspaceId },
      columns: { id: true },
    })
    if (existing) {
      return
    }

    const now = new Date()

    const firstStep = await db.query.sequenceStepModel.findFirst({
      where: { sequenceId, order: 0, isActive: true },
      columns: { id: true, delayDays: true, delayMinutes: true },
    })

    const nextRunAt = firstStep
      ? new Date(
          now.getTime() +
            firstStep.delayDays * 24 * 60 * 60 * 1000 +
            firstStep.delayMinutes * 60 * 1000,
        )
      : now

    await enrollContactInSequence({
      workspaceId,
      contactId,
      sequenceId,
      nextRunAt,
      nextStepId: firstStep?.id ?? null,
      enrolledAt: now,
    })

    const sequence = await db.query.sequenceModel.findFirst({
      where: { id: sequenceId },
      columns: { name: true },
    })

    await emitSequenceSubscribed(
      workspaceId,
      contactId,
      sequenceId,
      sequence?.name ?? "",
      contactInboxId,
    )
  }

  async listByContactId(props: {
    workspaceId: string
    contactId: string
    tx?: DrizzleClient
  }): Promise<{ sequenceId: string; sequenceName: string }[]> {
    const { workspaceId, contactId, tx = db } = props

    const enrollments = await tx.query.contactsOnSequenceModel.findMany({
      where: { workspaceId, contactId },
      columns: { sequenceId: true },
      with: { sequence: { columns: { name: true } } },
    })

    return enrollments.map((enrollment) => ({
      sequenceId: enrollment.sequenceId,
      sequenceName: enrollment.sequence.name,
    }))
  }

  /**
   * Sequence stop-on-reply (s220b): ends the contact's enrolments in every
   * sequence of the workspace that has `stopOnReply` on and that already
   * existed when the reply arrived (`repliedAt`): a late or re-delivered
   * reply event never ends an enrolment the reply itself started (a keyword
   * flow's subscribe step). Other enrolments, and the contact's parked flow
   * waits, are untouched (a `waitForEvent` replied branch must still fire).
   * Returns the ended sequence ids.
   */
  /**
   * Outreach B-1 (s226b, owner s223b): an out-of-office answer PAUSES the
   * contact's stop-on-reply enrolments for `pauseMs` (14 days) instead of
   * ending them: `pausedUntil` = now + pauseMs (a repeated OOO re-extends
   * from now, never stacks), pending dispatches move to at least then (DB
   * first, the schedule after commit). The enrolment rows are locked, as in
   * advanceEnrollment, so a step advancing concurrently is never missed.
   * Only enrolments that existed when the answer arrived. Returns the
   * paused sequence ids.
   */
  async pauseForAutoReply(props: {
    workspaceId: string
    contactId: string
    occurredAt: Date
    pauseMs?: number
    now?: Date
  }): Promise<string[]> {
    const { workspaceId, contactId, occurredAt } = props
    if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
      throw new TypeError("pauseForAutoReply: invalid occurredAt")
    }
    const pauseMs = props.pauseMs ?? OOO_PAUSE_MS
    if (
      !(Number.isInteger(pauseMs) && pauseMs > 0 && pauseMs <= OOO_PAUSE_MS)
    ) {
      throw new RangeError("pauseForAutoReply: pauseMs out of range")
    }
    const until = new Date((props.now ?? new Date()).getTime() + pauseMs)
    const { sequenceIds, moved } = await db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: contactsOnSequenceModel.id,
          sequenceId: contactsOnSequenceModel.sequenceId,
        })
        .from(contactsOnSequenceModel)
        .innerJoin(
          sequenceModel,
          and(
            eq(sequenceModel.id, contactsOnSequenceModel.sequenceId),
            eq(sequenceModel.workspaceId, contactsOnSequenceModel.workspaceId),
          ),
        )
        .where(
          and(
            eq(contactsOnSequenceModel.workspaceId, workspaceId),
            eq(contactsOnSequenceModel.contactId, contactId),
            eq(contactsOnSequenceModel.status, "active"),
            eq(sequenceModel.stopOnReply, true),
            lte(contactsOnSequenceModel.enrolledAt, occurredAt),
          ),
        )
      if (rows.length === 0) {
        return { sequenceIds: [] as string[], moved: [] }
      }
      const ids = rows.map((row) => row.id)
      // Lock order = removal's (dispatches, then the enrolment; Codex
      // s226b): the pending dispatches FOR UPDATE first...
      const pending = await tx
        .select({
          id: sequenceDispatchModel.id,
          bucket: sequenceDispatchModel.bucket,
          runAtMs: sequenceDispatchModel.runAtMs,
          anytime: sequenceStepModel.anytime,
          sendTimeStart: sequenceStepModel.sendTimeStart,
          sendTimeEnd: sequenceStepModel.sendTimeEnd,
          sendDays: sequenceStepModel.sendDays,
        })
        .from(sequenceDispatchModel)
        .innerJoin(
          sequenceStepModel,
          eq(sequenceStepModel.id, sequenceDispatchModel.stepId),
        )
        .where(
          and(
            eq(sequenceDispatchModel.workspaceId, workspaceId),
            inArray(sequenceDispatchModel.enrollmentId, ids),
            eq(sequenceDispatchModel.status, "pending"),
          ),
        )
        .for("update", { of: sequenceDispatchModel })
      // ...then the enrolment rows (the UPDATE locks them). A dispatch a
      // concurrent advance creates meanwhile is held at send time
      // (deferIfPaused), which reads the committed pause.
      await tx
        .update(contactsOnSequenceModel)
        .set({
          pausedUntil: until,
          nextRunAt: sql`GREATEST(${contactsOnSequenceModel.nextRunAt}, ${until})`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(contactsOnSequenceModel.workspaceId, workspaceId),
            inArray(contactsOnSequenceModel.id, ids),
            eq(contactsOnSequenceModel.status, "active"),
          ),
        )
      const movedRows: { id: string; bucket: number; runAtMs: string }[] = []
      for (const dispatch of pending) {
        // The pause end, moved into the step's send window; never earlier.
        const runAt = calculateNextValidSendTime(until, dispatch).getTime()
        if (Number(dispatch.runAtMs) >= runAt) {
          continue
        }
        await tx
          .update(sequenceDispatchModel)
          .set({ runAtMs: String(runAt) })
          .where(
            and(
              eq(sequenceDispatchModel.workspaceId, workspaceId),
              eq(sequenceDispatchModel.id, dispatch.id),
            ),
          )
        movedRows.push({
          id: dispatch.id,
          bucket: dispatch.bucket,
          runAtMs: String(runAt),
        })
      }
      return {
        sequenceIds: [...new Set(rows.map((row) => row.sequenceId))],
        moved: movedRows,
      }
    })
    try {
      await rescheduleDispatches(moved)
    } catch (err) {
      // The DB is authoritative: an early fire is re-queued at its DB time.
      logger.warn({ err, workspaceId }, "pauseForAutoReply: reschedule failed")
    }
    return sequenceIds
  }

  /**
   * The send-time half of the out-of-office pause (Codex s226b): a claimed
   * (running) dispatch whose enrolment is paused goes back to pending at the
   * pause end, moved into the step's send window, instead of sending. This
   * catches a dispatch claimed before the pause, or created by an advance
   * racing it. Returns the new run time to schedule, or null to send now.
   */
  async deferIfPaused(props: {
    dispatchId: string
    workspaceId: string
    now?: Date
  }): Promise<{ bucket: number; runAtMs: number } | null> {
    const now = props.now ?? new Date()
    return await db.transaction(async (tx) => {
      const [dispatch] = await tx
        .select({
          bucket: sequenceDispatchModel.bucket,
          status: sequenceDispatchModel.status,
          pausedUntil: contactsOnSequenceModel.pausedUntil,
          anytime: sequenceStepModel.anytime,
          sendTimeStart: sequenceStepModel.sendTimeStart,
          sendTimeEnd: sequenceStepModel.sendTimeEnd,
          sendDays: sequenceStepModel.sendDays,
        })
        .from(sequenceDispatchModel)
        .innerJoin(
          contactsOnSequenceModel,
          and(
            eq(contactsOnSequenceModel.id, sequenceDispatchModel.enrollmentId),
            eq(
              contactsOnSequenceModel.workspaceId,
              sequenceDispatchModel.workspaceId,
            ),
          ),
        )
        .innerJoin(
          sequenceStepModel,
          eq(sequenceStepModel.id, sequenceDispatchModel.stepId),
        )
        .where(
          and(
            eq(sequenceDispatchModel.id, props.dispatchId),
            eq(sequenceDispatchModel.workspaceId, props.workspaceId),
          ),
        )
        .for("update", { of: sequenceDispatchModel })
      if (
        !dispatch?.pausedUntil ||
        dispatch.pausedUntil <= now ||
        dispatch.status !== "running"
      ) {
        return null
      }
      const runAtMs = calculateNextValidSendTime(
        dispatch.pausedUntil,
        dispatch,
      ).getTime()
      await tx
        .update(sequenceDispatchModel)
        .set({
          status: "pending",
          runAtMs: String(runAtMs),
          lockedAt: null,
          lockOwner: null,
        })
        .where(
          and(
            eq(sequenceDispatchModel.id, props.dispatchId),
            eq(sequenceDispatchModel.workspaceId, props.workspaceId),
          ),
        )
      return { bucket: dispatch.bucket, runAtMs }
    })
  }

  async removeStopOnReplyEnrollments(props: {
    workspaceId: string
    contactId: string
    repliedAt: Date
    contactInboxId?: string
  }): Promise<string[]> {
    const { workspaceId, contactId, repliedAt } = props
    if (!(repliedAt instanceof Date) || Number.isNaN(repliedAt.getTime())) {
      throw new TypeError("removeStopOnReplyEnrollments: invalid repliedAt")
    }
    const rows = await db
      .select({ sequenceId: contactsOnSequenceModel.sequenceId })
      .from(contactsOnSequenceModel)
      .innerJoin(
        sequenceModel,
        and(
          eq(sequenceModel.id, contactsOnSequenceModel.sequenceId),
          eq(sequenceModel.workspaceId, contactsOnSequenceModel.workspaceId),
        ),
      )
      .where(
        and(
          eq(contactsOnSequenceModel.workspaceId, workspaceId),
          eq(contactsOnSequenceModel.contactId, contactId),
          eq(sequenceModel.stopOnReply, true),
          lte(contactsOnSequenceModel.enrolledAt, repliedAt),
        ),
      )
    if (rows.length === 0) {
      return []
    }
    const sequenceIds = [...new Set(rows.map((row) => row.sequenceId))]
    await this.removeContactSequencesForContacts({
      workspaceId,
      contactIds: [contactId],
      sequenceIds,
      reason: "contact_replied",
      contactInboxId: props.contactInboxId,
    })
    return sequenceIds
  }

  async removeContactSequencesForContacts(
    params: RemoveContactSequencesForContactsParams,
  ): Promise<DispatchToRemove[]> {
    const { workspaceId, contactIds, sequenceIds, reason } = params
    const client = params.client ?? db
    const removeFromSchedule = params.removeFromSchedule ?? true
    const useTransaction = params.useTransaction ?? !params.client

    if (params.client && params.useTransaction) {
      throw new Error("client and useTransaction are mutually exclusive")
    }

    if (contactIds.length === 0 || sequenceIds.length === 0) {
      return []
    }

    // A threaded contactInboxId is only ever attributable to a single
    // contact's removal — honoring it for a multi-contact batch (builder
    // bulk unsubscribe, membership-diff) would misattribute every other
    // contact's unsubscribedFromSequence event to this one inbox.
    let attributableContactInboxId: string | undefined
    if (params.contactInboxId && contactIds.length === 1) {
      attributableContactInboxId = params.contactInboxId
    } else if (params.contactInboxId) {
      logger.warn(
        { workspaceId, contactCount: contactIds.length },
        "Dropping contactInboxId for a multi-contact sequence removal to avoid misattribution",
      )
    }

    const removeWithClient = async (tx: DrizzleClient) => {
      const enrollments = await tx.query.contactsOnSequenceModel.findMany({
        where: {
          contactId: { in: contactIds },
          sequenceId: { in: sequenceIds },
          workspaceId,
        },
        columns: {
          id: true,
          contactId: true,
          sequenceId: true,
          workspaceId: true,
        },
      })

      return await this.removeEnrollmentsWithClient(
        tx,
        enrollments,
        reason,
        attributableContactInboxId,
      )
    }

    const removalResult: RemoveEnrollmentsResult = useTransaction
      ? await this.runInTransaction(removeWithClient)
      : await removeWithClient(client)
    const { dispatchesToRemove, removedEnrollments } = removalResult

    if (removeFromSchedule) {
      try {
        await removeDispatchesFromSchedule(dispatchesToRemove)
      } catch (err) {
        logger.warn(
          { err, dispatchCount: dispatchesToRemove.length },
          "Failed to remove dispatches from schedule after DB commit",
        )
      }
    }

    // A supplied client may be an outer transaction; emit only when this service
    // owns the commit boundary so downstream workers never observe rolled-back removals.
    if (!params.client) {
      this.emitSequenceUnsubscribedEvents(removedEnrollments).catch((err) => {
        logger.warn(
          { err, removedCount: removedEnrollments.length },
          "Failed to emit sequence unsubscribed events",
        )
      })
    }

    return dispatchesToRemove
  }

  async removeContactSequencesForContact(
    params: RemoveContactSequencesForContactParams,
  ) {
    return await this.removeContactSequencesForContacts({
      workspaceId: params.workspaceId,
      contactIds: [params.contactId],
      sequenceIds: params.sequenceIds,
      reason: params.reason,
      client: params.client,
      removeFromSchedule: params.removeFromSchedule,
      useTransaction: params.useTransaction,
      contactInboxId: params.contactInboxId,
    })
  }

  async updateContactSequences(params: UpdateContactSequencesParams) {
    const { workspaceId, contactId, sequenceIds } = params
    const result = await db.transaction(async (tx) => {
      const currentIds = await this.getCurrentSequenceIds(
        contactId,
        workspaceId,
        tx,
      )
      const { toAdd, toRemove } = this.calculateSequenceDiff(
        currentIds,
        sequenceIds,
      )

      await this.assertSequencesInWorkspace({
        workspaceId,
        sequenceIds: toAdd,
        tx,
      })

      const dispatchesToRemove = await this.removeContactSequencesForContact({
        workspaceId,
        contactId,
        sequenceIds: toRemove,
        reason: "subscription_removed",
        client: tx,
        removeFromSchedule: false,
      })

      await this.addContactSequences(contactId, toAdd, workspaceId, tx)

      const returnedSequences = await tx.query.contactsOnSequenceModel.findMany(
        {
          where: {
            contactId,
            workspaceId,
          },
          with: { sequence: true },
        },
      )

      return {
        returnedSequences,
        dispatchesToRemove,
        removedEnrollments: toRemove.map((sequenceId) => ({
          contactId,
          sequenceId,
          workspaceId,
        })),
      }
    })

    try {
      await removeDispatchesFromSchedule(result.dispatchesToRemove)
    } catch (err) {
      logger.warn(
        { err, dispatchCount: result.dispatchesToRemove.length },
        "Failed to remove dispatches from schedule after DB commit",
      )
    }

    this.emitSequenceUnsubscribedEvents(result.removedEnrollments).catch(
      (err) => {
        logger.warn(
          { err, removedCount: result.removedEnrollments.length },
          "Failed to emit sequence unsubscribed events",
        )
      },
    )

    return result.returnedSequences
  }

  private async removeEnrollmentsWithClient(
    client: DrizzleClient,
    enrollments: Array<{
      contactId: string
      id: string
      sequenceId: string
      workspaceId: string
    }>,
    reason: RemoveReason,
    contactInboxId?: string,
  ): Promise<RemoveEnrollmentsResult> {
    if (enrollments.length === 0) {
      return { dispatchesToRemove: [], removedEnrollments: [] }
    }

    const canceledDispatches = (
      await Promise.all(
        enrollments.map((enrollment) =>
          cancelPendingDispatches({
            client,
            enrollmentId: enrollment.id,
            workspaceId: enrollment.workspaceId,
            reason,
            removeFromSchedule: false,
          }),
        ),
      )
    ).flat()

    await Promise.all(
      enrollments.map((enrollment) =>
        client
          .delete(contactsOnSequenceModel)
          .where(
            and(
              eq(contactsOnSequenceModel.id, enrollment.id),
              eq(contactsOnSequenceModel.workspaceId, enrollment.workspaceId),
            ),
          ),
      ),
    )

    return {
      dispatchesToRemove: canceledDispatches,
      removedEnrollments: enrollments.map((enrollment) => ({
        contactId: enrollment.contactId,
        sequenceId: enrollment.sequenceId,
        workspaceId: enrollment.workspaceId,
        contactInboxId,
      })),
    }
  }

  private async emitSequenceUnsubscribedEvents(
    removedEnrollments: RemovedEnrollment[],
  ): Promise<void> {
    if (removedEnrollments.length === 0) {
      return
    }

    const sequenceIds = [
      ...new Set(removedEnrollments.map((enrollment) => enrollment.sequenceId)),
    ]
    const sequences = await db
      .select({ id: sequenceModel.id, name: sequenceModel.name })
      .from(sequenceModel)
      .where(inArray(sequenceModel.id, sequenceIds))
    const sequenceNameById = new Map(
      sequences.map((sequence) => [sequence.id, sequence.name]),
    )

    await Promise.all(
      removedEnrollments.map((enrollment) =>
        emitSequenceUnsubscribed(
          enrollment.workspaceId,
          enrollment.contactId,
          enrollment.sequenceId,
          sequenceNameById.get(enrollment.sequenceId) ?? "",
          enrollment.contactInboxId,
        ),
      ),
    )
  }

  private async getCurrentSequenceIds(
    contactId: string,
    workspaceId: string,
    client: DrizzleClient = db,
  ) {
    const sequences = await client.query.contactsOnSequenceModel.findMany({
      where: {
        contactId,
        workspaceId,
      },
      columns: {
        sequenceId: true,
      },
    })

    return sequences.map((sequence) => sequence.sequenceId)
  }

  private calculateSequenceDiff(currentIds: string[], newIds: string[]) {
    const currentSet = new Set(currentIds)
    const newSet = new Set(newIds)

    return {
      toAdd: newIds.filter((id) => !currentSet.has(id)),
      toRemove: currentIds.filter((id) => !newSet.has(id)),
    }
  }

  private async addContactSequences(
    contactId: string,
    sequenceIds: string[],
    workspaceId: string,
    client: DrizzleClient = db,
  ) {
    if (sequenceIds.length === 0) {
      return
    }

    const now = new Date()
    const nextRunAtMap = await this.calculateNextRunAtBulk(
      workspaceId,
      sequenceIds,
      now,
      client,
    )

    for (const sequenceId of sequenceIds) {
      const nextRun = nextRunAtMap.get(sequenceId) ?? {
        nextRunAt: now,
        nextStepId: null,
      }

      await enrollContactInSequence({
        workspaceId,
        contactId,
        sequenceId,
        nextRunAt: nextRun.nextRunAt,
        nextStepId: nextRun.nextStepId,
        enrolledAt: now,
        client,
      })
    }
  }

  private async calculateNextRunAtBulk(
    workspaceId: string,
    sequenceIds: string[],
    enrolledAt: Date,
    client: DrizzleClient,
  ) {
    const firstSteps = await client.query.sequenceStepModel.findMany({
      where: {
        sequenceId: { in: sequenceIds },
        order: 0,
        isActive: true,
        sequence: { workspaceId },
      },
      columns: {
        id: true,
        sequenceId: true,
        delayDays: true,
        delayMinutes: true,
        delayUnit: true,
        specificDateTime: true,
      },
    })

    const stepMap = new Map(firstSteps.map((step) => [step.sequenceId, step]))
    const resultMap = new Map<
      string,
      { nextRunAt: Date; nextStepId: string | null }
    >()

    for (const sequenceId of sequenceIds) {
      const step = stepMap.get(sequenceId)
      if (!step) {
        resultMap.set(sequenceId, { nextRunAt: enrolledAt, nextStepId: null })
        continue
      }

      resultMap.set(sequenceId, {
        nextRunAt: calculateNextRunAtFromStep(step, enrolledAt),
        nextStepId: step.id,
      })
    }

    return resultMap
  }

  private async runInTransaction<T>(
    callback: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    return await db.transaction(callback)
  }

  /** First active step (order 0) — used to compute `nextRunAt` on enroll. */
  async findFirstActiveStep(props: {
    sequenceId: string
    tx?: DrizzleClient
  }): Promise<
    { id: string; delayDays: number; delayMinutes: number } | undefined
  > {
    const { sequenceId, tx = db } = props
    return await tx.query.sequenceStepModel.findFirst({
      where: { sequenceId, order: 0, isActive: true },
      columns: { id: true, delayDays: true, delayMinutes: true },
    })
  }

  /** Sequence name for the `sequenceSubscribed` emit. */
  async findSequenceName(props: {
    sequenceId: string
    tx?: DrizzleClient
  }): Promise<string | undefined> {
    const { sequenceId, tx = db } = props
    const sequence = await tx.query.sequenceModel.findFirst({
      where: { id: sequenceId },
      columns: { name: true },
    })
    return sequence?.name
  }

  /** Load a running dispatch for the sequence-flow worker handler. */
  findRunningDispatch(props: { dispatchId: string; workspaceId: string }) {
    return sequenceDispatchUtils.findRunning({ dbClient: db, ...props })
  }

  /** Mark a dispatch completed — keeps the `status = 'running'` idempotency guard. */
  markDispatchCompleted(props: {
    dispatchId: string
    workspaceId: string
    sentAt: Date
  }): Promise<void> {
    return sequenceDispatchUtils.markCompleted({ dbClient: db, ...props })
  }

  /** Mark a dispatch canceled — keeps the `status = 'running'` idempotency guard. */
  markDispatchCanceled(props: {
    dispatchId: string
    workspaceId: string
    reason: string
  }): Promise<void> {
    return sequenceDispatchUtils.markCanceled({ dbClient: db, ...props })
  }

  /** Mark a dispatch failed — keeps the `status = 'running'` idempotency guard. */
  markDispatchFailed(props: {
    dispatchId: string
    workspaceId: string
    errorMessage: string
  }): Promise<void> {
    return sequenceDispatchUtils.markFailed({ dbClient: db, ...props })
  }
}

export const contactSequenceService = new ContactSequenceService()
