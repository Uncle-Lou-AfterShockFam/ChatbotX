import {
  and,
  type DatabaseClient,
  db,
  eq,
  sql,
} from "@chatbotx.io/database/client"
import {
  MAX_DEAL_TASK_DESCRIPTION_LENGTH,
  MAX_DEAL_TASK_DUE_IN_DAYS,
  MAX_DEAL_TASK_TEMPLATES_PER_STAGE,
  MAX_DEAL_TASK_TITLE_LENGTH,
} from "@chatbotx.io/database/partials"
import { dealTaskTemplateModel } from "@chatbotx.io/database/schema"
import type { DealTaskTemplateModel } from "@chatbotx.io/database/types"
import { createId } from "@chatbotx.io/utils"
import { BaseService } from "../base.service"
import {
  parseOptionalText,
  parseRequiredText,
  resolveWorkspaceMember,
} from "../deal/shared"
import { notFoundException, validationException } from "../errors"
import type { DealViewer } from "../pipeline/access"
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
    viewer?: DealViewer | null
    tx?: DatabaseClient
  }): Promise<DealTaskTemplateModel[]> {
    const { workspaceId, pipelineId, viewer, tx = db } = props
    await pipelineService.findOrFail({
      workspaceId,
      id: pipelineId,
      viewer,
      tx,
    })
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
    viewer?: DealViewer | null
    tx?: DatabaseClient
  }): Promise<DealTaskTemplateModel> {
    const { workspaceId, pipelineId, stageId, viewer, tx = db } = props
    await pipelineService.resolveStage({
      workspaceId,
      pipelineId,
      stageId,
      viewer,
      tx,
    })
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
    viewer?: DealViewer | null
    tx?: DatabaseClient
  }): Promise<void> {
    const {
      workspaceId,
      pipelineId,
      stageId,
      templateId,
      viewer,
      tx = db,
    } = props
    if (viewer) {
      await pipelineService.resolveStage({
        workspaceId,
        pipelineId,
        stageId,
        viewer,
        tx,
      })
    }
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
    const title = parseRequiredText({
      value: data.title,
      field: "title",
      max: MAX_DEAL_TASK_TITLE_LENGTH,
    })
    const description = parseOptionalText({
      value: data.description,
      field: "description",
      max: MAX_DEAL_TASK_DESCRIPTION_LENGTH,
    })
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
    const assigneeId = assignToOwner
      ? null
      : await resolveWorkspaceMember({
          workspaceId,
          userId: data.assigneeId,
          tx,
          field: "assigneeId",
          role: "Assignee",
        })
    return { title, description, dueInDays, assignToOwner, assigneeId }
  }
}

export const dealTaskTemplateService = new DealTaskTemplateService()
