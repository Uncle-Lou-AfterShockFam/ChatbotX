import { and, type DatabaseClient, db, eq, sql } from "@chatbotx.io/database/client"
import {
  MAX_DEAL_TASK_DESCRIPTION_LENGTH,
  MAX_DEAL_TASK_DUE_IN_DAYS,
  MAX_DEAL_TASK_TEMPLATES_PER_STAGE,
  MAX_DEAL_TASK_TITLE_LENGTH,
} from "@chatbotx.io/database/partials"
import {
  dealTaskTemplateModel,
  workspaceMemberModel,
} from "@chatbotx.io/database/schema"
import type { DealTaskTemplateModel } from "@chatbotx.io/database/types"
import { createId } from "@chatbotx.io/utils"
import { BaseService } from "../base.service"
import { notFoundException, validationException } from "../errors"
import { pipelineService } from "../pipeline/service"

const TEMPLATE_NOT_FOUND = "Task template not found"
const ORDER_STEP = 1000

export type DealTaskTemplateData = {
  title: string
  description?: string | null
  dueInDays?: number | null
  assignToOwner?: boolean | null
  assigneeId?: string | null
}

/** Task templates per pipeline stage (mirrors `pipelineService.upsertStage`). */
export class DealTaskTemplateService extends BaseService {
  async listForStage(props: {
    workspaceId: string
    pipelineId: string
    stageId: string
    tx?: DatabaseClient
  }): Promise<DealTaskTemplateModel[]> {
    const { workspaceId, pipelineId, stageId, tx = db } = props
    await pipelineService.resolveStage({ workspaceId, pipelineId, stageId, tx })
    return await tx
      .select()
      .from(dealTaskTemplateModel)
      .where(
        and(
          eq(dealTaskTemplateModel.workspaceId, workspaceId),
          eq(dealTaskTemplateModel.stageId, stageId),
        ),
      )
      .orderBy(dealTaskTemplateModel.order, dealTaskTemplateModel.id)
  }

  /** Every template of a pipeline (the settings page loads them per card). */
  async listForPipeline(props: {
    workspaceId: string
    pipelineId: string
    tx?: DatabaseClient
  }): Promise<DealTaskTemplateModel[]> {
    const { workspaceId, pipelineId, tx = db } = props
    await pipelineService.findOrFail({ workspaceId, id: pipelineId, tx })
    return await tx
      .select()
      .from(dealTaskTemplateModel)
      .where(
        and(
          eq(dealTaskTemplateModel.workspaceId, workspaceId),
          eq(dealTaskTemplateModel.pipelineId, pipelineId),
        ),
      )
      .orderBy(dealTaskTemplateModel.stageId, dealTaskTemplateModel.order)
  }

  async upsert(props: {
    workspaceId: string
    pipelineId: string
    stageId: string
    templateId?: string | null
    data: DealTaskTemplateData
    tx?: DatabaseClient
  }): Promise<DealTaskTemplateModel> {
    const { workspaceId, pipelineId, stageId, tx = db } = props
    await pipelineService.resolveStage({ workspaceId, pipelineId, stageId, tx })
    const values = await this.parse({ workspaceId, data: props.data, tx })
    if (props.templateId) {
      const [updated] = await tx
        .update(dealTaskTemplateModel)
        .set(values)
        .where(
          and(
            eq(dealTaskTemplateModel.id, props.templateId),
            eq(dealTaskTemplateModel.workspaceId, workspaceId),
            eq(dealTaskTemplateModel.stageId, stageId),
          ),
        )
        .returning()
      if (!updated) {
        throw notFoundException(TEMPLATE_NOT_FOUND)
      }
      await this.audit("deal.task-template.update", updated.id)
      return updated
    }
    const [{ count, maxOrder }] = await tx
      .select({
        count: sql<number>`count(*)::int`,
        maxOrder: sql<number | null>`max(${dealTaskTemplateModel.order})`,
      })
      .from(dealTaskTemplateModel)
      .where(eq(dealTaskTemplateModel.stageId, stageId))
    if (Number(count) >= MAX_DEAL_TASK_TEMPLATES_PER_STAGE) {
      throw validationException(
        "stageId",
        `A stage holds at most ${MAX_DEAL_TASK_TEMPLATES_PER_STAGE} task templates.`,
      )
    }
    const [created] = await tx
      .insert(dealTaskTemplateModel)
      .values({
        id: createId(),
        workspaceId,
        pipelineId,
        stageId,
        order: (Number(maxOrder) || 0) + ORDER_STEP,
        ...values,
      })
      .returning()
    await this.audit("deal.task-template.create", created.id)
    return created
  }

  async remove(props: {
    workspaceId: string
    pipelineId: string
    stageId: string
    templateId: string
    tx?: DatabaseClient
  }): Promise<void> {
    const { workspaceId, stageId, templateId, tx = db } = props
    const deleted = await tx
      .delete(dealTaskTemplateModel)
      .where(
        and(
          eq(dealTaskTemplateModel.id, templateId),
          eq(dealTaskTemplateModel.workspaceId, workspaceId),
          eq(dealTaskTemplateModel.stageId, stageId),
        ),
      )
      .returning({ id: dealTaskTemplateModel.id })
    if (deleted.length === 0) {
      throw notFoundException(TEMPLATE_NOT_FOUND)
    }
    await this.audit("deal.task-template.delete", templateId)
  }

  private async parse(props: {
    workspaceId: string
    data: DealTaskTemplateData
    tx: DatabaseClient
  }): Promise<{
    title: string
    description: string | null
    dueInDays: number | null
    assignToOwner: boolean
    assigneeId: string | null
  }> {
    const { data, tx, workspaceId } = props
    if (data === null || typeof data !== "object") {
      throw validationException("title", "Template data is required.")
    }
    const title = typeof data.title === "string" ? data.title.trim() : ""
    if (title.length === 0 || title.length > MAX_DEAL_TASK_TITLE_LENGTH) {
      throw validationException(
        "title",
        `Title is required and at most ${MAX_DEAL_TASK_TITLE_LENGTH} characters.`,
      )
    }
    const description =
      data.description === null || data.description === undefined || data.description === ""
        ? null
        : String(data.description)
    if (description !== null && description.length > MAX_DEAL_TASK_DESCRIPTION_LENGTH) {
      throw validationException("description", "Description is too long.")
    }
    let dueInDays: number | null = null
    if (data.dueInDays !== null && data.dueInDays !== undefined) {
      if (
        typeof data.dueInDays !== "number" ||
        !Number.isInteger(data.dueInDays) ||
        data.dueInDays < 0 ||
        data.dueInDays > MAX_DEAL_TASK_DUE_IN_DAYS
      ) {
        throw validationException(
          "dueInDays",
          `dueInDays must be an integer between 0 and ${MAX_DEAL_TASK_DUE_IN_DAYS}.`,
        )
      }
      dueInDays = data.dueInDays
    }
    const assignToOwner = data.assignToOwner === true
    let assigneeId: string | null = null
    if (!assignToOwner && data.assigneeId) {
      const [member] = await tx
        .select({ userId: workspaceMemberModel.userId })
        .from(workspaceMemberModel)
        .where(
          and(
            eq(workspaceMemberModel.workspaceId, workspaceId),
            eq(workspaceMemberModel.userId, data.assigneeId),
          ),
        )
        .limit(1)
      if (!member) {
        throw validationException(
          "assigneeId",
          "Assignee is not a member of this workspace.",
        )
      }
      assigneeId = member.userId
    }
    return { title, description, dueInDays, assignToOwner, assigneeId }
  }
}

export const dealTaskTemplateService = new DealTaskTemplateService()
