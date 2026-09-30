import {
  and,
  type DatabaseClient,
  db,
  desc,
  eq,
  sql,
} from "@chatbotx.io/database/client"
import {
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
  replyClassificationModel,
  sequenceModel,
} from "@chatbotx.io/database/schema"
import type { ReplyClassificationModel } from "@chatbotx.io/database/types"
import { emitContactReplyClassified } from "@chatbotx.io/events"
import { createId } from "@chatbotx.io/utils"
import { dealService } from "../deal/service"
import { notFoundException, validationException } from "../errors"
import { logger } from "../logger"
import { pipelineService } from "../pipeline/service"

const BIGINT_ID = /^\d{1,19}$/
/** The one-line reason an operator (or a rule) gives, capped. */
export const MAX_REASON = 300

function assertIds(fn: string, ids: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(ids)) {
    if (typeof value !== "string" || !BIGINT_ID.test(value)) {
      throw validationException(field, `${fn}: ${field} must be a numeric id`)
    }
  }
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

export type ClassifyReplyResult = {
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
    const name = (props.name ?? "Outreach").trim()
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
  }): Promise<ClassifyReplyResult> {
    if (props === null || typeof props !== "object") {
      throw new TypeError("classifyReply: props must be an object")
    }
    const { workspaceId, contactId } = props
    assertIds("classifyReply", { workspaceId, contactId })
    if (props.actorId != null) {
      assertIds("classifyReply", { actorId: props.actorId })
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
      props.reason?.replace(/\s+/g, " ").trim().slice(0, MAX_REASON) || null
    const messageId =
      typeof props.messageId === "string" && props.messageId !== ""
        ? props.messageId.slice(0, 255)
        : null

    const contact = await db.query.contactModel.findFirst({
      where: { id: contactId, workspaceId },
      columns: { id: true, fullName: true, email: true },
    })
    if (!contact) {
      throw notFoundException("Contact not found")
    }
    const enrollment = await this.outreachEnrollment(workspaceId, contactId, db)
    // A rule class only matters to outreach: an out-of-office from a contact
    // in no outreach sequence is not recorded (no noise per inbound mail).
    if (!(manual || enrollment)) {
      return { classification: null, dealId: null }
    }

    let dealId: string | null = null
    if (manual && enrollment?.pipelineId && enrollment.stages) {
      dealId = await this.applyToDeal({
        workspaceId,
        contactId,
        replyClass: replyClass.data as OutreachStageKey,
        pipelineId: enrollment.pipelineId,
        stages: enrollment.stages,
        title: `${contact.fullName ?? contact.email ?? "Contact"} - ${enrollment.sequenceName}`,
        actorId: props.actorId ?? null,
      })
    }

    const [classification] = await db
      .insert(replyClassificationModel)
      .values({
        id: createId(),
        workspaceId,
        contactId,
        class: replyClass.data,
        source: source.data,
        reason,
        messageId,
        dealId,
        sequenceId: enrollment?.sequenceId ?? null,
        createdById: props.actorId ?? null,
      })
      .returning()
    if (!classification) {
      throw new Error("classifyReply: insert returned no row")
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
  }): Promise<string | null> {
    const { workspaceId, contactId, pipelineId, actorId } = props
    const stages = outreachStagesSchema.safeParse(props.stages)
    if (!stages.success) {
      logger.warn(
        { workspaceId, pipelineId },
        "classifyReply: the sequence's outreach stage map is malformed",
      )
      return null
    }
    const stageId = stages.data[props.replyClass]
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
    })
    if (!created && deal.stageId !== stageId) {
      await dealService.moveStage({
        workspaceId,
        id: deal.id,
        stageId,
        actorId,
      })
    }
    return deal.id
  }

  /** The contact's classifications, newest first. */
  async listByContact(props: {
    workspaceId: string
    contactId: string
    limit?: number
  }): Promise<ReplyClassificationModel[]> {
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
