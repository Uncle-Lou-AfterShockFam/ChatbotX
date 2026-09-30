import {
  and,
  type DatabaseClient,
  db,
  desc,
  eq,
  sql,
} from "@chatbotx.io/database/client"
import {
  MAX_REPLY_REASON,
  OUTREACH_STAGE_KEYS,
  type OutreachStageKey,
  type OutreachStages,
  outreachStagesSchema,
  type ReplyClass,
  type ReplyClassificationSource,
  replyClasses,
  replyClassificationSources,
  replyClassManualClasses,
} from "@chatbotx.io/database/partials"
import {
  contactsOnSequenceModel,
  pipelineStageModel,
  replyClassificationModel,
  sequenceModel,
} from "@chatbotx.io/database/schema"
import type { ReplyClassificationModel } from "@chatbotx.io/database/types"
import { emitContactReplyClassified } from "@chatbotx.io/events"
import { createId } from "@chatbotx.io/utils"
import { dealService } from "../deal/service"
import { notFoundException, validationException } from "../errors"
import { logger } from "../logger"
import type { DealViewer } from "../pipeline/access"
import { pipelineService } from "../pipeline/service"
import { assertIds } from "../validation"

/**
 * Manual classifications of one contact in one pipeline run one at a time
 * (probe s228b: two interleaved create-or-move calls could leave two open
 * deals, or a lost deal in an open stage). A transaction holds an advisory
 * lock while the deal service works on its own connections, so at most
 * MAX_LOCK_HOLDERS such transactions run per process: the pool (10) is
 * never starved of the connections the deal calls need. lock_timeout bounds
 * the wait on a contact another process is classifying.
 */
const MAX_LOCK_HOLDERS = 3
let lockHolders = 0
const lockWaiters: Array<() => void> = []

async function withContactPipelineLock<T>(
  key: { workspaceId: string; contactId: string; pipelineId: string },
  fn: () => Promise<T>,
): Promise<T> {
  if (lockHolders >= MAX_LOCK_HOLDERS) {
    await new Promise<void>((resolve) => lockWaiters.push(resolve))
  }
  lockHolders += 1
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '10s'`)
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`outreach-classify:${key.workspaceId}:${key.contactId}:${key.pipelineId}`}))`,
      )
      return await fn()
    })
  } finally {
    lockHolders -= 1
    lockWaiters.shift()?.()
  }
}

/**
 * `value` without the control characters a text column must never carry
 * (probe s228b: a NUL is a raw 500); tab, newline and CR are kept.
 */
function stripControl(value: string, replacement = ""): string {
  let out = ""
  for (const ch of value) {
    const code = ch.charCodeAt(0)
    const control =
      (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127
    out += control ? replacement : ch
  }
  return out
}

/** The Outreach pipeline's stages (ManyReach's model), in order. */
const OUTREACH_STAGES: Record<
  OutreachStageKey,
  {
    name: string
    color: string
    probability: number
    isWon: boolean
    isLost: boolean
  }
> = {
  interested: {
    name: "Interested",
    color: "#3b82f6",
    probability: 30,
    isWon: false,
    isLost: false,
  },
  maybeLater: {
    name: "Maybe later",
    color: "#a855f7",
    probability: 15,
    isWon: false,
    isLost: false,
  },
  meetingBooked: {
    name: "Meeting booked",
    color: "#f59e0b",
    probability: 50,
    isWon: false,
    isLost: false,
  },
  meetingCompleted: {
    name: "Meeting completed",
    color: "#14b8a6",
    probability: 70,
    isWon: false,
    isLost: false,
  },
  won: {
    name: "Won",
    color: "#22c55e",
    probability: 100,
    isWon: true,
    isLost: false,
  },
  notInterested: {
    name: "Not interested",
    color: "#ef4444",
    probability: 0,
    isWon: false,
    isLost: true,
  },
}

type ClassifyReplyResult = {
  /** null: a rule class for a contact in no outreach sequence (not recorded). */
  classification: ReplyClassificationModel | null
  dealId: string | null
}

/**
 * s228b outreach step 2 (owner 2026-09-30: rules first, AI later; the
 * pipeline is set per sequence). A contact's answer to outreach is
 * classified: the line's rules record ooo / auto / bounce, an operator sets
 * interested / maybeLater / notInterested. A manual class opens or moves the
 * contact's ONE open deal in the sequence's Outreach pipeline (at the mapped
 * stage; notInterested is the lost stage). Every classification emits
 * `contactReplyClassified` (sourceId = the class).
 */
class ReplyClassificationService {
  /**
   * Creates an Outreach pipeline (the six stages) and makes it the
   * sequence's: `outreachPipelineId` + the stage map. One transaction. A
   * taken name is the pipeline service's 400 `nameTaken`.
   */
  async createOutreachPipeline(props: {
    workspaceId: string
    sequenceId: string
    name?: string
  }): Promise<{ pipelineId: string; stages: OutreachStages }> {
    if (props === null || typeof props !== "object") {
      throw new TypeError("createOutreachPipeline: props must be an object")
    }
    const { workspaceId, sequenceId } = props
    assertIds("createOutreachPipeline", { workspaceId, sequenceId })
    if (props.name !== undefined && typeof props.name !== "string") {
      throw validationException("name", "Name must be a string.")
    }
    const name = stripControl(props.name ?? "Outreach").trim()
    if (name === "" || name.length > 100) {
      throw validationException("name", "Name must be 1-100 characters.")
    }
    return await db.transaction(async (tx) => {
      const [sequence] = await tx
        .select({ id: sequenceModel.id })
        .from(sequenceModel)
        .where(
          and(
            eq(sequenceModel.workspaceId, workspaceId),
            eq(sequenceModel.id, sequenceId),
          ),
        )
        .for("update")
      if (!sequence) {
        throw notFoundException("Sequence not found")
      }
      const pipeline = await pipelineService.create({
        workspaceId,
        data: {
          name,
          stages: OUTREACH_STAGE_KEYS.map((key) => OUTREACH_STAGES[key]),
        },
        tx,
      })
      const byOrder = [...pipeline.stages].sort((a, b) => a.order - b.order)
      const stages = outreachStagesSchema.parse(
        Object.fromEntries(
          OUTREACH_STAGE_KEYS.map((key, index) => [key, byOrder[index]?.id]),
        ),
      )
      await tx
        .update(sequenceModel)
        .set({
          outreachPipelineId: pipeline.id,
          outreachStages: stages,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sequenceModel.workspaceId, workspaceId),
            eq(sequenceModel.id, sequenceId),
          ),
        )
      return { pipelineId: pipeline.id, stages }
    })
  }

  /** Unlinks the sequence's Outreach pipeline (the pipeline itself stays). */
  async unlinkOutreachPipeline(props: {
    workspaceId: string
    sequenceId: string
  }): Promise<void> {
    if (props === null || typeof props !== "object") {
      throw new TypeError("unlinkOutreachPipeline: props must be an object")
    }
    const { workspaceId, sequenceId } = props
    assertIds("unlinkOutreachPipeline", { workspaceId, sequenceId })
    const updated = await db
      .update(sequenceModel)
      .set({
        outreachPipelineId: null,
        outreachStages: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sequenceModel.workspaceId, workspaceId),
          eq(sequenceModel.id, sequenceId),
        ),
      )
      .returning({ id: sequenceModel.id })
    if (updated.length === 0) {
      throw notFoundException("Sequence not found")
    }
  }

  /**
   * The contact's outreach enrolment a classification belongs to: the one
   * whose sequence has an Outreach pipeline, the most recently answered
   * first (any reply state beats none), then the most recently changed.
   */
  private async outreachEnrollment(
    workspaceId: string,
    contactId: string,
    tx: DatabaseClient,
    sequenceId?: string,
  ) {
    const [row] = await tx
      .select({
        sequenceId: contactsOnSequenceModel.sequenceId,
        sequenceName: sequenceModel.name,
        pipelineId: sequenceModel.outreachPipelineId,
        stages: sequenceModel.outreachStages,
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
          sql`${sequenceModel.outreachPipelineId} IS NOT NULL`,
          // Skeptic s228b: a contact in two outreach sequences is classified
          // for the one the caller names.
          sequenceId
            ? eq(contactsOnSequenceModel.sequenceId, sequenceId)
            : undefined,
        ),
      )
      .orderBy(
        sql`(${contactsOnSequenceModel.replyState} = 'none')`,
        sql`${contactsOnSequenceModel.repliedAt} DESC NULLS LAST`,
        desc(contactsOnSequenceModel.updatedAt),
      )
      .limit(1)
    return row
  }

  /**
   * Records a classification and applies it. Manual classes (the public
   * API, the inbox) move the outreach deal; rule classes only record.
   * Unknown contact = 404; a class the source may not set = 422.
   */
  async classifyReply(props: {
    workspaceId: string
    contactId: string
    class: ReplyClass
    source: ReplyClassificationSource
    reason?: string | null
    messageId?: string | null
    actorId?: string | null
    /** The outreach sequence it is for; omitted = the most recently answered. */
    sequenceId?: string | null
    /**
     * Skeptic s228b: a member's classification touches deals only as they
     * may (s193 pipeline access, onlyAssignedContacts). Workers and the
     * workspace-token API pass none (unscoped, like the deal API).
     */
    viewer?: DealViewer | null
  }): Promise<ClassifyReplyResult> {
    if (props === null || typeof props !== "object") {
      throw new TypeError("classifyReply: props must be an object")
    }
    const { workspaceId, contactId } = props
    assertIds("classifyReply", { workspaceId, contactId })
    if (props.actorId != null) {
      assertIds("classifyReply", { actorId: props.actorId })
    }
    if (props.sequenceId != null) {
      assertIds("classifyReply", { sequenceId: props.sequenceId })
    }
    const replyClass = replyClasses.safeParse(props.class)
    const source = replyClassificationSources.safeParse(props.source)
    if (!(replyClass.success && source.success)) {
      throw validationException("class", "Unknown class or source.")
    }
    const manual = replyClassManualClasses.safeParse(replyClass.data).success
    if (manual !== (source.data !== "rule")) {
      throw validationException(
        "class",
        manual
          ? "A rule never sets interested / maybeLater / notInterested."
          : "Only the line's rules set ooo / auto / bounce.",
      )
    }
    if (props.reason != null && typeof props.reason !== "string") {
      throw validationException("reason", "reason must be a string")
    }
    const reason =
      props.reason == null
        ? null
        : stripControl(props.reason, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, MAX_REPLY_REASON) || null
    const messageId =
      typeof props.messageId === "string" && props.messageId !== ""
        ? stripControl(props.messageId).slice(0, 255)
        : null
    // Skeptic s228b: message:received is redelivered; a message already
    // classified is not classified (or announced) again.
    if (messageId) {
      const existing = await this.findByMessage(workspaceId, messageId)
      if (existing) {
        return { classification: existing, dealId: existing.dealId }
      }
    }

    const contact = await db.query.contactModel.findFirst({
      where: { id: contactId, workspaceId },
      columns: { id: true, fullName: true, email: true },
    })
    if (!contact) {
      throw notFoundException("Contact not found")
    }
    const enrollment = await this.outreachEnrollment(
      workspaceId,
      contactId,
      db,
      props.sequenceId ?? undefined,
    )
    if (props.sequenceId && !enrollment) {
      throw notFoundException(
        "The contact is not in that sequence, or it has no Outreach pipeline",
      )
    }
    // A rule class only matters to outreach: an out-of-office from a contact
    // in no outreach sequence is not recorded (no noise per inbound mail).
    if (!(manual || enrollment)) {
      return { classification: null, dealId: null }
    }

    // The row first (probe s228b): a sequence deleted mid-flight fails here,
    // before any deal moved; the deal the class touched is written after.
    const [inserted] = await db
      .insert(replyClassificationModel)
      .values({
        id: createId(),
        workspaceId,
        contactId,
        class: replyClass.data,
        source: source.data,
        reason,
        messageId,
        sequenceId: enrollment?.sequenceId ?? null,
        createdById: props.actorId ?? null,
      })
      .onConflictDoNothing()
      .returning()
    if (!inserted) {
      // A concurrent delivery of the same message recorded it first.
      const existing = messageId
        ? await this.findByMessage(workspaceId, messageId)
        : undefined
      if (!existing) {
        throw new Error("classifyReply: insert returned no row")
      }
      return { classification: existing, dealId: existing.dealId }
    }
    let classification = inserted

    let dealId: string | null = null
    if (manual && enrollment?.pipelineId && enrollment.stages) {
      const pipelineId = enrollment.pipelineId
      const stages = enrollment.stages
      dealId = await withContactPipelineLock(
        { workspaceId, contactId, pipelineId },
        () =>
          this.applyToDeal({
            workspaceId,
            contactId,
            replyClass: replyClass.data as OutreachStageKey,
            pipelineId,
            stages,
            title: `${contact.fullName ?? contact.email ?? "Contact"} - ${enrollment.sequenceName}`,
            actorId: props.actorId ?? null,
            viewer: props.viewer ?? null,
          }),
      )
      if (dealId) {
        const [updated] = await db
          .update(replyClassificationModel)
          .set({ dealId, updatedAt: new Date() })
          .where(
            and(
              eq(replyClassificationModel.workspaceId, workspaceId),
              eq(replyClassificationModel.id, inserted.id),
            ),
          )
          .returning()
        classification = updated ?? { ...inserted, dealId }
      }
    }

    await emitContactReplyClassified(workspaceId, contactId, {
      classificationId: classification.id,
      class: classification.class,
      source: classification.source,
      reason: classification.reason,
      sequenceId: classification.sequenceId,
      dealId,
    }).catch((err: unknown) => {
      logger.warn({ err, workspaceId }, "classifyReply: event emit failed")
    })
    return { classification, dealId }
  }

  /**
   * interested / maybeLater: open the contact's deal at that stage (at most
   * one open deal per contact per pipeline, the deal service's lock), or
   * move the open one there. notInterested: move the open deal to the lost
   * stage; with no open deal there is nothing to close. Returns the deal id.
   */
  private async applyToDeal(props: {
    workspaceId: string
    contactId: string
    replyClass: OutreachStageKey
    pipelineId: string
    stages: OutreachStages
    title: string
    actorId: string | null
    viewer: DealViewer | null
  }): Promise<string | null> {
    const { workspaceId, contactId, pipelineId, actorId, viewer } = props
    const stages = outreachStagesSchema.safeParse(props.stages)
    if (!stages.success) {
      logger.warn(
        { workspaceId, pipelineId },
        "classifyReply: the sequence's outreach stage map is malformed",
      )
      return null
    }
    const stageId = stages.data[props.replyClass]
    // Skeptic s228b: a stage deleted (or a map pointing elsewhere) since the
    // pipeline was linked never costs the classification itself.
    const [stage] = await db
      .select({ id: pipelineStageModel.id })
      .from(pipelineStageModel)
      .where(
        and(
          eq(pipelineStageModel.id, stageId),
          eq(pipelineStageModel.pipelineId, pipelineId),
        ),
      )
    if (!stage) {
      logger.warn(
        { workspaceId, pipelineId, stage: props.replyClass },
        "classifyReply: the mapped outreach stage no longer exists",
      )
      return null
    }
    if (props.replyClass === "notInterested") {
      const open = await dealService.findOpenForContactInPipeline({
        workspaceId,
        contactId,
        pipelineId,
      })
      if (!open) {
        return null
      }
      await dealService.moveStage({
        workspaceId,
        id: open.id,
        stageId,
        actorId,
        viewer,
      })
      return open.id
    }
    const { deal, created } = await dealService.createUnlessOpen({
      workspaceId,
      data: {
        title: props.title.slice(0, 200),
        pipelineId,
        stageId,
        contactId,
      },
      actorId,
      viewer,
    })
    if (!created && deal.stageId !== stageId) {
      await dealService.moveStage({
        workspaceId,
        id: deal.id,
        stageId,
        actorId,
        viewer,
      })
    }
    return deal.id
  }

  private async findByMessage(workspaceId: string, messageId: string) {
    const [row] = await db
      .select()
      .from(replyClassificationModel)
      .where(
        and(
          eq(replyClassificationModel.workspaceId, workspaceId),
          eq(replyClassificationModel.messageId, messageId),
        ),
      )
      .limit(1)
    return row
  }

  /** The contact's classifications, newest first. */
  async listByContact(props: {
    workspaceId: string
    contactId: string
    limit?: number
  }): Promise<ReplyClassificationModel[]> {
    if (props === null || typeof props !== "object") {
      throw new TypeError("listByContact: props must be an object")
    }
    const { workspaceId, contactId } = props
    assertIds("listByContact", { workspaceId, contactId })
    const limit = Math.min(Math.max(props.limit ?? 20, 1), 100)
    return await db
      .select()
      .from(replyClassificationModel)
      .where(
        and(
          eq(replyClassificationModel.workspaceId, workspaceId),
          eq(replyClassificationModel.contactId, contactId),
        ),
      )
      .orderBy(desc(replyClassificationModel.createdAt))
      .limit(limit)
  }
}

export const replyClassificationService = new ReplyClassificationService()
