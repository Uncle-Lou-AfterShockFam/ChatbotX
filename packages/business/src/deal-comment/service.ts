import {
  and,
  asc,
  type DatabaseClient,
  db,
  desc,
  eq,
  sql,
} from "@chatbotx.io/database/client"
import {
  MAX_DEAL_COMMENT_CHARS,
  MAX_DEAL_COMMENT_MENTIONS,
  MAX_DEAL_COMMENTS_PER_DEAL,
} from "@chatbotx.io/database/partials"
import {
  dealActivityModel,
  dealCommentMentionModel,
  dealCommentModel,
} from "@chatbotx.io/database/schema"
import type {
  DealCommentMentionRef,
  DealCommentModel,
  DealModel,
} from "@chatbotx.io/database/types"
import { emitDealMentioned } from "@chatbotx.io/events"
import { createId } from "@chatbotx.io/utils"
import {
  clipText,
  parseMentions,
  renderMentionsPlain,
} from "@chatbotx.io/utils/mentions"
import { BaseService } from "../base.service"
import { dealService } from "../deal/service"
import { dealEventMetadata } from "../deal/shared"
import { notFoundException, validationException } from "../errors"
import { logger } from "../logger"
import { notificationService } from "../notification/service"
import { type DealViewer, isUnrestrictedViewer } from "../pipeline/access"
import { pipelineMemberService } from "../pipeline/members"
import { pipelineService } from "../pipeline/service"
import { workspaceMemberService } from "../workspace-member/service"

const COMMENT_NOT_FOUND = "Comment not found"
const EXCERPT_MAX = 500
const WHITESPACE = /\s+/g

/**
 * Comments on a deal with `@[Label](u:<id>)` mentions (s193 part 3b). A
 * create is ONE transaction (comment row + one mention row per user + the
 * `commented` activity), then `dealMentioned` is emitted once per mentioned
 * user for the deal's contact (a contact-less deal emits nothing: the
 * phase-1 rule, the mention rows still carry PR5's per-user state). Every
 * mentioned user must be a workspace member, and a member of the pipeline
 * when it is members-only. Edits re-parse the body and ADD mention rows;
 * they never delete one already read. Author or super admin edits/deletes.
 */
export class DealCommentService extends BaseService {
  async findOrFail(props: {
    workspaceId: string
    dealId: string
    commentId: string
    viewer?: DealViewer | null
    tx?: DatabaseClient
  }): Promise<DealCommentModel> {
    const { workspaceId, dealId, commentId, viewer, tx = db } = props
    if (viewer) {
      await dealService.findOrFail({ workspaceId, id: dealId, viewer, tx })
    }
    const [row] = await tx
      .select()
      .from(dealCommentModel)
      .where(
        and(
          eq(dealCommentModel.id, commentId),
          eq(dealCommentModel.dealId, dealId),
          eq(dealCommentModel.workspaceId, workspaceId),
        ),
      )
      .limit(1)
    if (!row) {
      throw notFoundException(COMMENT_NOT_FOUND)
    }
    return row
  }

  /** Newest first, capped. */
  async list(props: {
    workspaceId: string
    dealId: string
    limit?: number
    viewer?: DealViewer | null
    tx?: DatabaseClient
  }): Promise<DealCommentModel[]> {
    const { workspaceId, dealId, viewer, tx = db } = props
    const limit = Math.min(Math.max(props.limit ?? 100, 1), 500)
    await dealService.findOrFail({ workspaceId, id: dealId, viewer, tx })
    return await tx
      .select()
      .from(dealCommentModel)
      .where(eq(dealCommentModel.dealId, dealId))
      .orderBy(desc(dealCommentModel.createdAt), asc(dealCommentModel.id))
      .limit(limit)
  }

  async create(props: {
    workspaceId: string
    dealId: string
    body: string
    actorId?: string | null
    viewer?: DealViewer | null
  }): Promise<DealCommentModel> {
    const { workspaceId, dealId, viewer } = props
    const actorId = props.actorId ?? null
    const body = this.parseBody(props.body)
    const mentions = this.parseMentionList(body)
    const { comment, deal } = await db.transaction(async (tx) => {
      const current = await dealService.findOrFail({
        workspaceId,
        id: dealId,
        viewer,
        tx,
      })
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(dealCommentModel)
        .where(eq(dealCommentModel.dealId, dealId))
      if (Number(count) >= MAX_DEAL_COMMENTS_PER_DEAL) {
        throw validationException(
          "dealId",
          `A deal holds at most ${MAX_DEAL_COMMENTS_PER_DEAL} comments.`,
          { reason: "tooManyComments" },
        )
      }
      await this.assertMentionable({ workspaceId, deal: current, mentions, tx })
      const [row] = await tx
        .insert(dealCommentModel)
        .values({
          id: createId(),
          workspaceId,
          dealId,
          authorId: actorId,
          body,
          // jsonb: written explicitly, never by a drizzle default (AGENTS.md)
          mentions,
        })
        .returning()
      await this.insertMentionRows({ tx, comment: row, userIds: mentions })
      await tx.insert(dealActivityModel).values({
        id: createId(),
        dealId,
        type: "commented",
        actorId,
        payload: {
          commentId: row.id,
          excerpt: this.excerpt(body),
          mentionedUserIds: mentions.map((m) => m.userId),
        },
      })
      return { comment: row, deal: current }
    })
    await this.audit("deal.comment.create", comment.id)
    await this.emitMentions(deal, comment, mentions)
    await this.notifyMentions(deal, comment, mentions)
    return comment
  }

  /** Author (or a super admin) only; new mentions are added, none removed. */
  async update(props: {
    workspaceId: string
    dealId: string
    commentId: string
    body: string
    actorId?: string | null
    viewer?: DealViewer | null
  }): Promise<DealCommentModel> {
    const { workspaceId, dealId, commentId, viewer } = props
    const actorId = props.actorId ?? null
    const body = this.parseBody(props.body)
    const mentions = this.parseMentionList(body)
    const { comment, deal, added } = await db.transaction(async (tx) => {
      const current = await this.findOrFail({
        workspaceId,
        dealId,
        commentId,
        viewer,
        tx,
      })
      this.assertCanEdit({ comment: current, actorId, viewer })
      const deal = await dealService.findOrFail({ workspaceId, id: dealId, tx })
      const known = new Set(current.mentions.map((m) => m.userId))
      const added = mentions.filter((m) => !known.has(m.userId))
      // Only NEW mentions are validated: an earlier one whose user has since
      // left stays (its row may be read) and must not block a typo fix.
      await this.assertMentionable({ workspaceId, deal, mentions: added, tx })
      const byUser = new Map(mentions.map((m) => [m.userId, m]))
      const [row] = await tx
        .update(dealCommentModel)
        .set({
          body,
          // keep every earlier mention, with its label refreshed from the body
          mentions: [
            ...current.mentions.map((m) => byUser.get(m.userId) ?? m),
            ...added,
          ],
          editedAt: new Date(),
        })
        .where(eq(dealCommentModel.id, commentId))
        .returning()
      await this.insertMentionRows({ tx, comment: row, userIds: added })
      return { comment: row, deal, added }
    })
    await this.audit("deal.comment.update", commentId)
    await this.emitMentions(deal, comment, added)
    await this.notifyMentions(deal, comment, added)
    return comment
  }

  async remove(props: {
    workspaceId: string
    dealId: string
    commentId: string
    actorId?: string | null
    viewer?: DealViewer | null
  }): Promise<void> {
    const { workspaceId, dealId, commentId, viewer } = props
    const current = await this.findOrFail({
      workspaceId,
      dealId,
      commentId,
      viewer,
    })
    this.assertCanEdit({
      comment: current,
      actorId: props.actorId ?? null,
      viewer,
    })
    // DealCommentMention rows cascade on commentId.
    await db.delete(dealCommentModel).where(eq(dealCommentModel.id, commentId))
    await this.audit("deal.comment.delete", commentId)
  }

  /** Mark the viewer's own mention on a comment read (idempotent). */
  async markMentionRead(props: {
    workspaceId: string
    commentId: string
    userId: string
    tx?: DatabaseClient
  }): Promise<{ marked: boolean }> {
    const { workspaceId, commentId, userId, tx = db } = props
    const rows = await tx
      .update(dealCommentMentionModel)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(dealCommentMentionModel.workspaceId, workspaceId),
          eq(dealCommentMentionModel.commentId, commentId),
          eq(dealCommentMentionModel.userId, userId),
          sql`${dealCommentMentionModel.readAt} is null`,
        ),
      )
      .returning({ id: dealCommentMentionModel.id })
    if (rows.length > 0) {
      await notificationService.markReadByComment({
        workspaceId,
        userId,
        commentId,
        tx,
      })
    }
    return { marked: rows.length > 0 }
  }

  // ---- internals ----------------------------------------------------------

  private parseBody(value: unknown): string {
    const body = typeof value === "string" ? value.trim() : ""
    if (body.length === 0) {
      throw validationException("body", "Comment text is required.")
    }
    if (body.length > MAX_DEAL_COMMENT_CHARS) {
      throw validationException(
        "body",
        `Comment text is at most ${MAX_DEAL_COMMENT_CHARS} characters.`,
      )
    }
    return body
  }

  private parseMentionList(body: string): DealCommentMentionRef[] {
    const mentions = parseMentions(body)
    if (mentions.length > MAX_DEAL_COMMENT_MENTIONS) {
      throw validationException(
        "body",
        `A comment mentions at most ${MAX_DEAL_COMMENT_MENTIONS} people.`,
        { reason: "tooManyMentions" },
      )
    }
    return mentions
  }

  private excerpt(body: string): string {
    return clipText(
      renderMentionsPlain(body).replace(WHITESPACE, " ").trim(),
      EXCERPT_MAX,
    )
  }

  /**
   * Every mentioned user is a workspace member; on a members-only pipeline
   * also a pipeline member (else the mention reaches someone who cannot open
   * the deal). The 422 names the offending ids.
   */
  private async assertMentionable(props: {
    workspaceId: string
    deal: DealModel
    mentions: DealCommentMentionRef[]
    tx: DatabaseClient
  }): Promise<void> {
    const { workspaceId, deal, mentions, tx } = props
    if (mentions.length === 0) {
      return
    }
    const ids = mentions.map((m) => m.userId)
    const members = await workspaceMemberService.listExistingUserIds({
      workspaceId,
      userIds: ids,
      tx,
    })
    const known = new Set(members.map((m) => m.userId))
    let missing = ids.filter((id) => !known.has(id))
    if (missing.length === 0) {
      const pipeline = await pipelineService.findOrFail({
        workspaceId,
        id: deal.pipelineId,
        tx,
      })
      if (pipeline.settings.access === "members") {
        const rows = await pipelineMemberService.list({
          workspaceId,
          pipelineId: pipeline.id,
          tx,
        })
        const inPipeline = new Set(rows.map((r) => r.userId))
        missing = ids.filter((id) => !inPipeline.has(id))
      }
    }
    if (missing.length > 0) {
      throw validationException(
        "body",
        `Cannot mention: ${missing.join(", ")} (not a member of this workspace / pipeline).`,
        { reason: "mentionNotMember", userIds: missing.join(",") },
      )
    }
  }

  private assertCanEdit(props: {
    comment: DealCommentModel
    actorId: string | null
    viewer?: DealViewer | null
  }): void {
    const { comment, actorId, viewer } = props
    if (viewer && isUnrestrictedViewer(viewer)) {
      return
    }
    // No viewer = a workspace token (or a worker) = the workspace itself:
    // it may edit or delete ANY comment (documented on the public routes).
    if (!viewer) {
      return
    }
    if (comment.authorId !== null && comment.authorId === actorId) {
      return
    }
    throw validationException(
      "commentId",
      "Only the author or a super admin can change this comment.",
      { reason: "notCommentAuthor" },
    )
  }

  private async insertMentionRows(props: {
    tx: DatabaseClient
    comment: DealCommentModel
    userIds: DealCommentMentionRef[]
  }): Promise<void> {
    if (props.userIds.length === 0) {
      return
    }
    await props.tx
      .insert(dealCommentMentionModel)
      .values(
        props.userIds.map((m) => ({
          id: createId(),
          workspaceId: props.comment.workspaceId,
          commentId: props.comment.id,
          dealId: props.comment.dealId,
          userId: m.userId,
        })),
      )
      .onConflictDoNothing()
  }

  /**
   * Each mentioned user's own notification (s194), beside `emitMentions` so
   * a contact-less deal still notifies. The author mentioning themselves is
   * silent. Never throws.
   */
  private async notifyMentions(
    deal: DealModel,
    comment: DealCommentModel,
    mentions: DealCommentMentionRef[],
  ): Promise<void> {
    const excerpt = this.excerpt(comment.body)
    for (const mention of mentions) {
      if (mention.userId === comment.authorId) {
        continue
      }
      try {
        await notificationService.notify({
          workspaceId: deal.workspaceId,
          userId: mention.userId,
          type: "dealMentioned",
          dealId: deal.id,
          commentId: comment.id,
          payload: {
            pipelineId: deal.pipelineId,
            dealTitle: deal.title,
            actorId: comment.authorId,
            excerpt,
          },
        })
      } catch (error) {
        logger.warn(
          { error, commentId: comment.id, userId: mention.userId },
          "deal-comment: notify failed",
        )
      }
    }
  }

  private async emitMentions(
    deal: DealModel,
    comment: DealCommentModel,
    mentions: DealCommentMentionRef[],
  ): Promise<void> {
    if (!deal.contactId || mentions.length === 0) {
      if (mentions.length > 0) {
        logger.info(
          { dealId: deal.id, commentId: comment.id },
          "deal-comment: contact-less deal, dealMentioned not emitted",
        )
      }
      return
    }
    const excerpt = this.excerpt(comment.body)
    for (const mention of mentions) {
      try {
        await emitDealMentioned(deal.workspaceId, deal.contactId, {
          ...dealEventMetadata(deal),
          commentId: comment.id,
          authorId: comment.authorId,
          mentionedUserId: mention.userId,
          excerpt,
        })
      } catch (error) {
        logger.warn(
          { error, commentId: comment.id, userId: mention.userId },
          "deal-comment: dealMentioned emit failed",
        )
      }
    }
  }
}

export const dealCommentService = new DealCommentService()
