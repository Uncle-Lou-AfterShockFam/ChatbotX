import {
  and,
  asc,
  type DatabaseClient,
  db,
  eq,
} from "@chatbotx.io/database/client"
import { MAX_PIPELINE_MEMBERS } from "@chatbotx.io/database/partials"
import {
  pipelineMemberModel,
  pipelineModel,
} from "@chatbotx.io/database/schema"
import type { PipelineMemberModel } from "@chatbotx.io/database/types"
import { createId } from "@chatbotx.io/utils"
import { BaseService } from "../base.service"
import { notFoundException, validationException } from "../errors"
import { logger } from "../logger"
import { workspaceMemberService } from "../workspace-member/service"

const USER_ID = /^\d+$/

export type PipelineMemberInput = { userId: string; inRotation?: boolean }

/**
 * The members of a pipeline (s193): the list `settings.access = "members"`
 * gates on and `settings.assignOwner = "roundRobin"` walks. `set` REPLACES
 * the list (order = array order); `pickRoundRobin` advances the cursor on
 * the pipeline row under `FOR UPDATE`, so two concurrent deal inserts can
 * never both read the same cursor.
 */
export class PipelineMemberService extends BaseService {
  async list(props: {
    workspaceId: string
    pipelineId: string
    tx?: DatabaseClient
  }): Promise<PipelineMemberModel[]> {
    const { workspaceId, pipelineId, tx = db } = props
    return await tx
      .select()
      .from(pipelineMemberModel)
      .where(
        and(
          eq(pipelineMemberModel.workspaceId, workspaceId),
          eq(pipelineMemberModel.pipelineId, pipelineId),
        ),
      )
      .orderBy(
        asc(pipelineMemberModel.order),
        asc(pipelineMemberModel.createdAt),
      )
  }

  /** Pipeline ids of the workspace the user is a member of. */
  async listPipelineIdsForUser(props: {
    workspaceId: string
    userId: string
    tx?: DatabaseClient
  }): Promise<Set<string>> {
    const { workspaceId, userId, tx = db } = props
    const rows = await tx
      .select({ pipelineId: pipelineMemberModel.pipelineId })
      .from(pipelineMemberModel)
      .where(
        and(
          eq(pipelineMemberModel.workspaceId, workspaceId),
          eq(pipelineMemberModel.userId, userId),
        ),
      )
    return new Set(rows.map((row) => row.pipelineId))
  }

  async isMember(props: {
    workspaceId: string
    pipelineId: string
    userId: string
    tx?: DatabaseClient
  }): Promise<boolean> {
    const { workspaceId, pipelineId, userId, tx = db } = props
    const [row] = await tx
      .select({ id: pipelineMemberModel.id })
      .from(pipelineMemberModel)
      .where(
        and(
          eq(pipelineMemberModel.workspaceId, workspaceId),
          eq(pipelineMemberModel.pipelineId, pipelineId),
          eq(pipelineMemberModel.userId, userId),
        ),
      )
      .limit(1)
    return row !== undefined
  }

  /**
   * Replace the member list. Every user must be a workspace member (422
   * `notWorkspaceMember` names the offenders), duplicates are a 422, the
   * list is capped. Delete + insert in one transaction; the round-robin
   * cursor is left alone (a removed cursor user restarts the rotation at the
   * first member on the next pick).
   */
  async set(props: {
    workspaceId: string
    pipelineId: string
    members: PipelineMemberInput[]
    tx?: DatabaseClient
  }): Promise<PipelineMemberModel[]> {
    const { workspaceId, pipelineId } = props
    const members = this.parseMembers(props.members)
    const run = async (tx: DatabaseClient) => {
      const [pipeline] = await tx
        .select({ id: pipelineModel.id })
        .from(pipelineModel)
        .where(
          and(
            eq(pipelineModel.id, pipelineId),
            eq(pipelineModel.workspaceId, workspaceId),
          ),
        )
        .limit(1)
      if (!pipeline) {
        throw notFoundException("Pipeline not found")
      }
      const wanted = members.map((m) => m.userId)
      const existing = await workspaceMemberService.listExistingUserIds({
        workspaceId,
        userIds: wanted,
        tx,
      })
      const known = new Set(existing.map((row) => row.userId))
      const missing = wanted.filter((id) => !known.has(id))
      if (missing.length > 0) {
        throw validationException(
          "members",
          `Not a member of this workspace: ${missing.join(", ")}.`,
          { reason: "notWorkspaceMember", userIds: missing.join(",") },
        )
      }
      await tx
        .delete(pipelineMemberModel)
        .where(eq(pipelineMemberModel.pipelineId, pipelineId))
      if (members.length === 0) {
        return []
      }
      return await tx
        .insert(pipelineMemberModel)
        .values(
          members.map((m, index) => ({
            id: createId(),
            workspaceId,
            pipelineId,
            userId: m.userId,
            inRotation: m.inRotation,
            order: (index + 1) * 1000,
          })),
        )
        .returning()
    }
    const rows = props.tx
      ? await run(props.tx)
      : await db.transaction(async (tx) => await run(tx))
    await this.audit("pipeline.members.set", pipelineId)
    return rows
  }

  /**
   * Next owner for a deal created without one. Locks the pipeline row
   * (`SELECT ... FOR UPDATE`), reads the in-rotation members in order, picks
   * the one after `roundRobinLastUserId` (unknown or departed cursor = the
   * first) and stores it as the new cursor in the SAME transaction as the
   * deal insert; the row lock serialises concurrent creates. Empty rotation
   * = `null` (ownerless deal, logged).
   */
  async pickRoundRobin(props: {
    workspaceId: string
    pipelineId: string
    tx: DatabaseClient
  }): Promise<string | null> {
    const { workspaceId, pipelineId, tx } = props
    const [locked] = await tx
      .select({
        id: pipelineModel.id,
        cursor: pipelineModel.roundRobinLastUserId,
      })
      .from(pipelineModel)
      .where(
        and(
          eq(pipelineModel.id, pipelineId),
          eq(pipelineModel.workspaceId, workspaceId),
        ),
      )
      .for("update")
    if (!locked) {
      throw notFoundException("Pipeline not found")
    }
    const rotation = await tx
      .select({ userId: pipelineMemberModel.userId })
      .from(pipelineMemberModel)
      .where(
        and(
          eq(pipelineMemberModel.pipelineId, pipelineId),
          eq(pipelineMemberModel.inRotation, true),
        ),
      )
      .orderBy(
        asc(pipelineMemberModel.order),
        asc(pipelineMemberModel.createdAt),
      )
    if (rotation.length === 0) {
      logger.warn(
        { pipelineId },
        "round-robin owner: no member in rotation, deal stays ownerless",
      )
      return null
    }
    const last = rotation.findIndex((m) => m.userId === locked.cursor)
    const next = rotation[(last + 1) % rotation.length]
    await tx
      .update(pipelineModel)
      .set({ roundRobinLastUserId: next.userId })
      .where(eq(pipelineModel.id, pipelineId))
    return next.userId
  }

  private parseMembers(
    input: PipelineMemberInput[],
  ): { userId: string; inRotation: boolean }[] {
    if (!Array.isArray(input)) {
      throw validationException("members", "Members must be a list.")
    }
    if (input.length > MAX_PIPELINE_MEMBERS) {
      throw validationException(
        "members",
        `A pipeline has at most ${MAX_PIPELINE_MEMBERS} members.`,
        { reason: "tooManyMembers" },
      )
    }
    const seen = new Set<string>()
    return input.map((m, index) => {
      const userId =
        m && typeof m === "object" && typeof m.userId === "string"
          ? m.userId.trim()
          : ""
      if (!USER_ID.test(userId)) {
        throw validationException(
          `members.${index}.userId`,
          "User id is required.",
        )
      }
      if (seen.has(userId)) {
        throw validationException(
          `members.${index}.userId`,
          "Duplicate member.",
          { reason: "duplicateMember" },
        )
      }
      seen.add(userId)
      return { userId, inRotation: m.inRotation !== false }
    })
  }
}

export const pipelineMemberService = new PipelineMemberService()
