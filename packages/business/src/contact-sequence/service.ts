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
  enrollContactInSequence,
  enrollContactsInSequenceBulk,
  reactivateEnrollment as reactivateEndedEnrollment,
  removeDispatchesFromSchedule,
  rescheduleDispatches,
  scheduleDispatches,
  sequenceDispatchUtils,
  TERMINAL_END_REASONS,
} from "@chatbotx.io/sequence-scheduler"
import { BaseService } from "../base.service"
import { type ContactAccessScope, contactService } from "../contact/service"
import {
  enrollmentChangedException,
  enrollmentNotReactivatableException,
  notFoundException,
  sequenceNotHeldException,
  validationException,
} from "../errors"
import { logger } from "../logger"
import { assertIds } from "../validation"

type DrizzleClient = DatabaseClient | Transaction

/** s236: a bigint id as it travels (findReplyGate guards its inputs). */
const BIGINT_ID = /^\d{1,19}$/

/** lastError is operator-facing: the missing names, capped. */
const MAX_HOLD_REASON = 500
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
/**
 * Why an enrolment ENDED (s228b: stored as `endReason`; the row is kept).
 * `bounced` and `unsubscribed` are terminal (TERMINAL_END_REASONS).
 */
type RemoveReason =
  | "subscription_removed"
  | "unsubscribed_via_flow"
  | "company_stopped"
  | "contact_replied"
  | "no_email_thread"
  | "bounced"
  | "unsubscribed"

/** An enrolment that is not ended (NULL status included). */
const notEnded = () =>
  sql`${contactsOnSequenceModel.status} IS DISTINCT FROM 'ended'`
/** `notEnded` as a relational-query filter (keep the two in step). */
const NOT_ENDED = {
  OR: [{ status: { ne: "ended" } }, { status: { isNull: true as const } }],
}

type EndReply = { state: "replied" | "bounced"; at: Date }

type RemoveContactSequencesForContactsParams = {
  client?: DrizzleClient
  /**
   * The contact's answer that ended it: a reply (stop-on-reply) or a bounce;
   * written to replyState + repliedAt (s228b).
   */
  reply?: EndReply
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
): Promise<Map<string, { id: string; status: string | null }>> {
  const enrollments = await db.query.contactsOnSequenceModel.findMany({
    where: {
      workspaceId,
      contactId: { in: contactIds },
      sequenceId: { in: sequenceIds },
    },
    columns: {
      id: true,
      contactId: true,
      sequenceId: true,
      status: true,
    },
  })

  return new Map(
    enrollments.map((e) => [
      `${e.contactId}-${e.sequenceId}`,
      { id: e.id, status: e.status },
    ]),
  )
}

function buildEnrollmentRecords(
  contacts: Array<{ id: string }>,
  sequenceIds: string[],
  existingKeys: ReadonlyMap<string, unknown>,
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

      // s228b: an ENDED enrolment is resumed at its step (a terminal end is
      // left as it is); every other existing one is left as-is.
      for (const existing of existingKeys.values()) {
        if (existing.status === "ended") {
          const result = await reactivateEndedEnrollment({
            workspaceId,
            enrollmentId: existing.id,
          })
          if (result.kind === "reactivated") {
            await scheduleDispatches(result.dispatches)
          }
        }
      }

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
    // A flow step's sequence must be this workspace's (probe s228b).
    await this.assertSequencesInWorkspace({
      workspaceId,
      sequenceIds: [sequenceId],
    })

    const existing = await db.query.contactsOnSequenceModel.findFirst({
      where: { contactId, sequenceId, workspaceId },
      columns: { status: true },
    })
    if (existing && existing.status !== "ended") {
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

    const outcome = await enrollContactInSequence({
      workspaceId,
      contactId,
      sequenceId,
      nextRunAt,
      nextStepId: firstStep?.id ?? null,
      enrolledAt: now,
    })
    if (outcome === "skipped") {
      return
    }

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

  /**
   * The contact's enrolments. ENDED ones (s228b: kept with their reason) are
   * left out unless `includeEnded` - every internal caller means "the
   * sequences the contact is in"; the public list shows the history too.
   */
  async listByContactId(props: {
    workspaceId: string
    contactId: string
    includeEnded?: boolean
    tx?: DrizzleClient
  }): Promise<
    {
      sequenceId: string
      sequenceName: string
      status: string | null
      lastError: string | null
      enrolledAt: Date
      completedAt: Date | null
      endedAt: Date | null
      endReason: string | null
      replyState: string
      repliedAt: Date | null
      pausedUntil: Date | null
      currentStep: number
      updatedAt: Date
    }[]
  > {
    const { workspaceId, contactId, tx = db } = props

    const enrollments = await tx.query.contactsOnSequenceModel.findMany({
      where: props.includeEnded
        ? { workspaceId, contactId }
        : { workspaceId, contactId, ...NOT_ENDED },
      columns: {
        sequenceId: true,
        status: true,
        lastError: true,
        enrolledAt: true,
        completedAt: true,
        endedAt: true,
        endReason: true,
        replyState: true,
        repliedAt: true,
        pausedUntil: true,
        currentStep: true,
        updatedAt: true,
      },
      with: { sequence: { columns: { name: true } } },
    })

    return enrollments.map(({ sequence, ...enrollment }) => ({
      ...enrollment,
      sequenceName: sequence.name,
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
        .orderBy(contactsOnSequenceModel.id)
        // s228b: the enrolment rows FIRST, then their dispatches - the order
        // every enrolment writer takes (removal, hold, resume, advance).
        .for("no key update", { of: contactsOnSequenceModel })
      if (rows.length === 0) {
        return { sequenceIds: [] as string[], moved: [] }
      }
      const ids = rows.map((row) => row.id)
      // ...then the pending dispatches.
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
      // A dispatch a concurrent advance created before the lock is held at
      // send time (deferIfPaused), which reads the committed pause.
      await tx
        .update(contactsOnSequenceModel)
        .set({
          pausedUntil: until,
          nextRunAt: sql`GREATEST(${contactsOnSequenceModel.nextRunAt}, ${until})`,
          // s228b: the out-of-office answer is the enrolment's reply state.
          replyState: "ooo",
          repliedAt: occurredAt,
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
   * The send-time gate of a claimed (running) dispatch.
   * - It is no longer running (canceled meanwhile), or its row is gone:
   *   "ended" - send nothing.
   * - Its enrolment ENDED (s228b: a removal keeps the row, so the dispatch
   *   no longer cascades away): the dispatch is canceled with the end
   *   reason and "ended" is returned - send nothing.
   * - Its enrolment is paused (the out-of-office half, Codex s226b): the
   *   dispatch goes back to pending at the pause end, moved into the step's
   *   send window; the new run time is returned to schedule. This catches a
   *   dispatch claimed before the pause, or created by an advance racing it.
   * Otherwise null: send now.
   */
  async deferIfPaused(props: {
    dispatchId: string
    workspaceId: string
    now?: Date
  }): Promise<{ bucket: number; runAtMs: number } | "ended" | null> {
    const now = props.now ?? new Date()
    return await db.transaction(async (tx) => {
      // The enrolment FIRST (shared: gates of one enrolment never wait on
      // each other), then the dispatch - every enrolment writer's order, so
      // an end, pause or reactivate is either fully seen here or waits
      // (probe s228b: an unlocked read let a pause-defer escape an end).
      const [ref] = await tx
        .select({ enrollmentId: sequenceDispatchModel.enrollmentId })
        .from(sequenceDispatchModel)
        .where(
          and(
            eq(sequenceDispatchModel.id, props.dispatchId),
            eq(sequenceDispatchModel.workspaceId, props.workspaceId),
          ),
        )
      if (!ref) {
        return "ended"
      }
      await tx
        .select({ id: contactsOnSequenceModel.id })
        .from(contactsOnSequenceModel)
        .where(
          and(
            eq(contactsOnSequenceModel.workspaceId, props.workspaceId),
            eq(contactsOnSequenceModel.id, ref.enrollmentId),
          ),
        )
        .for("share")
      const [dispatch] = await tx
        .select({
          bucket: sequenceDispatchModel.bucket,
          status: sequenceDispatchModel.status,
          enrollmentStatus: contactsOnSequenceModel.status,
          endReason: contactsOnSequenceModel.endReason,
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
        // LEFT: the end check never depends on the step row still existing.
        .leftJoin(
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
      // No longer running (a concurrent end or reactivate canceled it):
      // never send it.
      if (dispatch?.status !== "running") {
        return "ended"
      }
      if (dispatch.enrollmentStatus === "ended") {
        await tx
          .update(sequenceDispatchModel)
          .set({
            status: "canceled",
            lastError: dispatch.endReason ?? "ended",
            lockedAt: null,
            lockOwner: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(sequenceDispatchModel.id, props.dispatchId),
              eq(sequenceDispatchModel.workspaceId, props.workspaceId),
            ),
          )
        return "ended"
      }
      if (!dispatch.pausedUntil || dispatch.pausedUntil <= now) {
        return null
      }
      const runAtMs = calculateNextValidSendTime(dispatch.pausedUntil, {
        ...dispatch,
        anytime: dispatch.anytime ?? true,
      }).getTime()
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

  /**
   * Outreach B-1 H3 (s227b, owner: the hold lives on the SEQUENCE STEP): a
   * claimed (running) dispatch whose step's `holdOnMissing` fields are not
   * all set HOLDS its enrolment instead of sending: enrolment status 'held'
   * with the reason in lastError, the dispatch 'held' (neither sent nor
   * failed). Lock order = the enrolment, then the dispatch: the order a
   * removal takes (s228b: it ends the enrolment, then cancels) - the other
   * order deadlocked against an unenrol (probe s227b). Only a RUNNING
   * dispatch of an ACTIVE enrolment is held; false = nothing to hold, the
   * caller then sends nothing.
   */
  async holdEnrollment(props: {
    dispatchId: string
    workspaceId: string
    reason: string
  }): Promise<boolean> {
    if (props === null || typeof props !== "object") {
      throw new TypeError("holdEnrollment: props must be an object")
    }
    const { dispatchId, workspaceId } = props
    assertIds("holdEnrollment", { dispatchId, workspaceId })
    if (typeof props.reason !== "string" || props.reason.trim() === "") {
      throw new TypeError("holdEnrollment: a reason is required")
    }
    const reason = props.reason.slice(0, MAX_HOLD_REASON)
    return await db.transaction(async (tx) => {
      // A plain read first: only a running dispatch is ever locked here,
      // and always after its enrolment (every enrolment writer's order).
      const [ref] = await tx
        .select({
          enrollmentId: sequenceDispatchModel.enrollmentId,
          status: sequenceDispatchModel.status,
        })
        .from(sequenceDispatchModel)
        .where(
          and(
            eq(sequenceDispatchModel.id, dispatchId),
            eq(sequenceDispatchModel.workspaceId, workspaceId),
          ),
        )
      if (ref?.status !== "running") {
        return false
      }
      const [enrollment] = await tx
        .select({ status: contactsOnSequenceModel.status })
        .from(contactsOnSequenceModel)
        .where(
          and(
            eq(contactsOnSequenceModel.workspaceId, workspaceId),
            eq(contactsOnSequenceModel.id, ref.enrollmentId),
          ),
        )
        .for("update")
      if (enrollment?.status !== "active") {
        return false
      }
      const [dispatch] = await tx
        .select({ status: sequenceDispatchModel.status })
        .from(sequenceDispatchModel)
        .where(
          and(
            eq(sequenceDispatchModel.id, dispatchId),
            eq(sequenceDispatchModel.workspaceId, workspaceId),
          ),
        )
        .for("update")
      if (dispatch?.status !== "running") {
        return false
      }
      await tx
        .update(contactsOnSequenceModel)
        .set({
          status: "held",
          lastError: reason,
          nextRunAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(contactsOnSequenceModel.workspaceId, workspaceId),
            eq(contactsOnSequenceModel.id, ref.enrollmentId),
          ),
        )
      await tx
        .update(sequenceDispatchModel)
        .set({
          status: "held",
          lastError: reason,
          lockedAt: null,
          lockOwner: null,
        })
        .where(
          and(
            eq(sequenceDispatchModel.id, dispatchId),
            eq(sequenceDispatchModel.workspaceId, workspaceId),
          ),
        )
      return true
    })
  }

  /**
   * An operator resumes a HELD enrolment (owner s227b: manual only): status
   * back to 'active', lastError cleared, the held dispatch back to pending
   * at max(now, pausedUntil) moved into its step's send window (DB first,
   * the schedule after commit). The step re-checks its fields when it runs,
   * so a field still missing holds it again. Locks the enrolment first, then
   * its held dispatches (holdEnrollment's and a removal's order). Not
   * enrolled = 404; not held = 409 (a concurrent second resume waits on the
   * enrolment lock, then gets it); held but its step was deleted (the
   * dispatch cascaded away) = 409 saying so - unsubscribe clears it.
   */
  async resumeHeldEnrollment(props: {
    workspaceId: string
    contactId: string
    sequenceId: string
    now?: Date
  }): Promise<{ runAt: Date }> {
    if (props === null || typeof props !== "object") {
      throw new TypeError("resumeHeldEnrollment: props must be an object")
    }
    const { workspaceId, contactId, sequenceId } = props
    assertIds("resumeHeldEnrollment", { workspaceId, contactId, sequenceId })
    const now = props.now ?? new Date()
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new TypeError("resumeHeldEnrollment: invalid now")
    }
    const { moved, runAt } = await db.transaction(async (tx) => {
      const [enrollment] = await tx
        .select({
          id: contactsOnSequenceModel.id,
          status: contactsOnSequenceModel.status,
          pausedUntil: contactsOnSequenceModel.pausedUntil,
        })
        .from(contactsOnSequenceModel)
        .where(
          and(
            eq(contactsOnSequenceModel.workspaceId, workspaceId),
            eq(contactsOnSequenceModel.contactId, contactId),
            eq(contactsOnSequenceModel.sequenceId, sequenceId),
          ),
        )
        .for("update")
      if (!enrollment) {
        throw notFoundException("The contact is not in this sequence")
      }
      if (enrollment.status !== "held") {
        throw sequenceNotHeldException()
      }
      const dispatches = await tx
        .select({
          id: sequenceDispatchModel.id,
          bucket: sequenceDispatchModel.bucket,
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
            eq(sequenceDispatchModel.enrollmentId, enrollment.id),
            eq(sequenceDispatchModel.status, "held"),
          ),
        )
        .for("update", { of: sequenceDispatchModel })
      if (dispatches.length === 0) {
        throw sequenceNotHeldException(
          "The step this contact was held at no longer exists; unsubscribe the contact to clear it",
        )
      }
      const floor =
        enrollment.pausedUntil && enrollment.pausedUntil > now
          ? enrollment.pausedUntil
          : now
      const planned = dispatches.map((dispatch) => ({
        id: dispatch.id,
        bucket: dispatch.bucket,
        runAtMs: String(calculateNextValidSendTime(floor, dispatch).getTime()),
      }))
      const first = Math.min(...planned.map((row) => Number(row.runAtMs)))
      await tx
        .update(contactsOnSequenceModel)
        .set({
          status: "active",
          lastError: null,
          nextRunAt: new Date(first),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(contactsOnSequenceModel.workspaceId, workspaceId),
            eq(contactsOnSequenceModel.id, enrollment.id),
          ),
        )
      for (const row of planned) {
        await tx
          .update(sequenceDispatchModel)
          .set({ status: "pending", runAtMs: row.runAtMs, lastError: null })
          .where(
            and(
              eq(sequenceDispatchModel.workspaceId, workspaceId),
              eq(sequenceDispatchModel.id, row.id),
            ),
          )
      }
      return { moved: planned, runAt: new Date(first) }
    })
    try {
      await rescheduleDispatches(moved)
    } catch (err) {
      // The DB is authoritative: the row stays pending at its DB time.
      logger.warn(
        { err, workspaceId },
        "resumeHeldEnrollment: reschedule failed",
      )
    }
    return { runAt }
  }

  /**
   * An operator reactivates an ENDED enrolment (s228b, the ManyReach rule):
   * it resumes at the step it stopped at (reactivateEnrollment has the
   * rules). `expectedUpdatedAt` is the row's `updatedAt` as the caller read
   * it (contacts.listSequences): a row changed since = 409 enrollmentChanged.
   * Not enrolled = 404; not ended, or ended for a terminal reason (bounced,
   * unsubscribed) = 409 notReactivatable.
   */
  async reactivateEnrollment(props: {
    workspaceId: string
    contactId: string
    sequenceId: string
    expectedUpdatedAt: Date
  }): Promise<{ runAt: Date | null }> {
    if (props === null || typeof props !== "object") {
      throw new TypeError("reactivateEnrollment: props must be an object")
    }
    const { workspaceId, contactId, sequenceId, expectedUpdatedAt } = props
    assertIds("reactivateEnrollment", { workspaceId, contactId, sequenceId })
    if (
      !(expectedUpdatedAt instanceof Date) ||
      Number.isNaN(expectedUpdatedAt.getTime())
    ) {
      throw validationException(
        "expectedUpdatedAt",
        "reactivateEnrollment: expectedUpdatedAt must be a valid date",
      )
    }
    const row = await db.query.contactsOnSequenceModel.findFirst({
      where: { workspaceId, contactId, sequenceId },
      columns: { id: true },
    })
    if (!row) {
      throw notFoundException("The contact is not in this sequence")
    }
    const result = await reactivateEndedEnrollment({
      workspaceId,
      enrollmentId: row.id,
      expectedUpdatedAt,
    })
    switch (result.kind) {
      case "notFound":
        throw notFoundException("The contact is not in this sequence")
      case "changed":
        throw enrollmentChangedException()
      case "notEnded":
        throw enrollmentNotReactivatableException(
          "This subscription has not ended",
        )
      case "terminal":
        throw enrollmentNotReactivatableException(
          `This subscription ended for good (${result.endReason})`,
        )
      default:
        break
    }
    try {
      await scheduleDispatches(result.dispatches)
    } catch (err) {
      // The DB is authoritative: the row stays pending at its DB time.
      logger.warn({ err, workspaceId }, "reactivateEnrollment: schedule failed")
    }
    return { runAt: result.runAt }
  }

  /**
   * s228b: a hard bounce or an email unsubscribe ENDS the contact's outreach
   * enrolments (the stop-on-reply sequences; other sequences are not
   * outreach - the email suppression / opt-out still stops their mail) for
   * good. A completed enrolment is left as it is: `bounced` /
   * `unsubscribed` are terminal and overwrite an earlier non-terminal end
   * (the removal's rule). A bounce is also the reply state. Returns the
   * sequence ids it ended.
   */
  async endOutreach(props: {
    workspaceId: string
    contactId: string
    reason: "bounced" | "unsubscribed"
    at?: Date
  }): Promise<string[]> {
    if (props === null || typeof props !== "object") {
      throw new TypeError("endOutreach: props must be an object")
    }
    const { workspaceId, contactId, reason } = props
    assertIds("endOutreach", { workspaceId, contactId })
    if (reason !== "bounced" && reason !== "unsubscribed") {
      throw new TypeError("endOutreach: reason must be bounced or unsubscribed")
    }
    const at = props.at ?? new Date()
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
      throw new TypeError("endOutreach: invalid at")
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
          // Skeptic s228b: a finished enrolment's record is history, and an
          // earlier end keeps its reply state (the removal's CASE below);
          // only a live one, or a non-terminal end, is made final here.
          sql`${contactsOnSequenceModel.status} IS DISTINCT FROM 'completed'`,
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
      reason,
      ...(reason === "bounced" ? { reply: { state: "bounced", at } } : {}),
    })
    return sequenceIds
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
          notEnded(),
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
      reply: { state: "replied", at: repliedAt },
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
      // The enrolment rows FIRST, in id order, then their dispatches (the
      // order hold, resume, advance and the out-of-office pause take).
      const enrollments = await tx
        .select({
          id: contactsOnSequenceModel.id,
          contactId: contactsOnSequenceModel.contactId,
          sequenceId: contactsOnSequenceModel.sequenceId,
          workspaceId: contactsOnSequenceModel.workspaceId,
          status: contactsOnSequenceModel.status,
        })
        .from(contactsOnSequenceModel)
        .where(
          and(
            eq(contactsOnSequenceModel.workspaceId, workspaceId),
            inArray(contactsOnSequenceModel.contactId, contactIds),
            inArray(contactsOnSequenceModel.sequenceId, sequenceIds),
            // A terminal reason (a bounce, an unsubscribe) also overwrites
            // an earlier non-terminal end: it must never be reactivated.
            TERMINAL_END_REASONS.has(reason)
              ? sql`(${notEnded()} OR ${contactsOnSequenceModel.endReason} IS NULL OR ${contactsOnSequenceModel.endReason} NOT IN ('bounced', 'unsubscribed'))`
              : notEnded(),
          ),
        )
        .orderBy(contactsOnSequenceModel.id)
        .for("no key update")

      return await this.removeEnrollmentsWithClient(
        tx,
        enrollments,
        reason,
        attributableContactInboxId,
        params.reply,
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
      status: string | null
    }>,
    reason: RemoveReason,
    contactInboxId?: string,
    reply?: EndReply,
  ): Promise<RemoveEnrollmentsResult> {
    if (enrollments.length === 0) {
      return { dispatchesToRemove: [], removedEnrollments: [] }
    }

    // s228b: the enrolment ENDS (its row, step position and history stay);
    // its pending and held dispatches are canceled with the reason. A
    // running one is stopped at send time (deferIfPaused reads the end).
    const workspaceId = enrollments[0]?.workspaceId ?? ""
    const ids = enrollments.map((enrollment) => enrollment.id)
    const now = new Date()
    const canceledDispatches = await client
      .update(sequenceDispatchModel)
      .set({ status: "canceled", lastError: reason, updatedAt: now })
      .where(
        and(
          eq(sequenceDispatchModel.workspaceId, workspaceId),
          inArray(sequenceDispatchModel.enrollmentId, ids),
          inArray(sequenceDispatchModel.status, ["pending", "held"]),
        ),
      )
      .returning({
        id: sequenceDispatchModel.id,
        bucket: sequenceDispatchModel.bucket,
      })

    await client
      .update(contactsOnSequenceModel)
      .set({
        status: "ended",
        endReason: reason,
        // An end overwritten by a terminal reason keeps its first instant.
        endedAt: sql`COALESCE(${contactsOnSequenceModel.endedAt}, ${now})`,
        lockedAt: null,
        lockOwner: null,
        updatedAt: now,
        // An end being overwritten (a terminal reason after an earlier end)
        // keeps the answer it recorded then (skeptic s228b).
        ...(reply
          ? {
              replyState: sql`CASE WHEN ${contactsOnSequenceModel.status} = 'ended' THEN ${contactsOnSequenceModel.replyState} ELSE ${reply.state} END`,
              repliedAt: sql`CASE WHEN ${contactsOnSequenceModel.status} = 'ended' THEN ${contactsOnSequenceModel.repliedAt} ELSE ${reply.at} END`,
            }
          : {}),
      })
      .where(
        and(
          eq(contactsOnSequenceModel.workspaceId, workspaceId),
          inArray(contactsOnSequenceModel.id, ids),
        ),
      )

    return {
      dispatchesToRemove: canceledDispatches,
      // Only a row this removal ended is "unsubscribed" (an overwritten end
      // was announced when it first ended).
      removedEnrollments: enrollments
        .filter((enrollment) => enrollment.status !== "ended")
        .map((enrollment) => ({
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
        ...NOT_ENDED,
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

  /**
   * s236: what an email-line send of this dispatch needs to gate itself on a
   * reply at the line: the sequence's stop rule and the enrolment's cycle
   * (`enrolledAt`, `status`, and `repliedAt`, the answer the hub already
   * acted on). Workspace-scoped; null when the dispatch or enrolment is gone.
   */
  async findReplyGate(props: {
    dispatchId: string
    workspaceId: string
  }): Promise<{
    stopOnReply: boolean
    status: string | null
    enrolledAt: Date
    repliedAt: Date | null
  } | null> {
    // Ids are bigints: anything else can name no dispatch (and must not
    // reach the query as a cast error).
    if (
      !(
        BIGINT_ID.test(String(props?.dispatchId)) &&
        BIGINT_ID.test(String(props?.workspaceId))
      )
    ) {
      return null
    }
    const [row] = await db
      .select({
        stopOnReply: sequenceModel.stopOnReply,
        status: contactsOnSequenceModel.status,
        enrolledAt: contactsOnSequenceModel.enrolledAt,
        repliedAt: contactsOnSequenceModel.repliedAt,
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
        sequenceModel,
        and(
          eq(sequenceModel.id, contactsOnSequenceModel.sequenceId),
          eq(sequenceModel.workspaceId, contactsOnSequenceModel.workspaceId),
        ),
      )
      .where(
        and(
          eq(sequenceDispatchModel.id, props.dispatchId),
          eq(sequenceDispatchModel.workspaceId, props.workspaceId),
        ),
      )
      .limit(1)
    return row ?? null
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
