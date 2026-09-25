import {
  and,
  type DatabaseClient,
  db,
  eq,
  inArray,
  sql,
} from "@chatbotx.io/database/client"
import {
  MAX_DEAL_TASK_DESCRIPTION_LENGTH,
  MAX_DEAL_TASK_DUE_IN_DAYS,
  MAX_DEAL_TASK_TEMPLATE_DEPENDENCIES_PER_TEMPLATE,
  MAX_DEAL_TASK_TEMPLATES_PER_STAGE,
  MAX_DEAL_TASK_TITLE_LENGTH,
} from "@chatbotx.io/database/partials"
import {
  dealTaskTemplateDependencyModel,
  dealTaskTemplateModel,
} from "@chatbotx.io/database/schema"
import type {
  DealTaskTemplateDependencyModel,
  DealTaskTemplateModel,
} from "@chatbotx.io/database/types"
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
import { type EdgeRefusal, edgeRefusal } from "./schedule"

const TEMPLATE_NOT_FOUND = "Task template not found"
const ORDER_STEP = 1000
const TEMPLATE_EDGE_REFUSAL_MESSAGES: Record<EdgeRefusal, string> = {
  tooManyDependencies: `A template waits on at most ${MAX_DEAL_TASK_TEMPLATE_DEPENDENCIES_PER_TEMPLATE} templates.`,
  dependencyExists: "That dependency already exists.",
  dependencyCycle: "That dependency would create a cycle.",
}

export type DealTaskTemplateData = {
  title: string
  description?: string | null
  startInDays?: number | null
  dueInDays?: number | null
  assignToOwner?: boolean | null
  assigneeId?: string | null
}
/** A template plus the ids of the templates (same stage) it waits on. */
export type DealTaskTemplateWithDeps = DealTaskTemplateModel & {
  dependsOn: string[]
}

/** Task templates per pipeline stage (mirrors `pipelineService.upsertStage`). */
export class DealTaskTemplateService extends BaseService {
  async listForStage(props: {
    workspaceId: string
    pipelineId: string
    stageId: string
    tx?: DatabaseClient
  }): Promise<DealTaskTemplateWithDeps[]> {
    const { workspaceId, pipelineId, stageId, tx = db } = props
    await pipelineService.resolveStage({ workspaceId, pipelineId, stageId, tx })
    const rows = await tx
      .select()
      .from(dealTaskTemplateModel)
      .where(
        and(
          eq(dealTaskTemplateModel.workspaceId, workspaceId),
          eq(dealTaskTemplateModel.stageId, stageId),
        ),
      )
      .orderBy(dealTaskTemplateModel.order, dealTaskTemplateModel.id)
    return await this.withDeps(rows, tx)
  }

  /** Every template of a pipeline (the settings page loads them per card). */
  async listForPipeline(props: {
    workspaceId: string
    pipelineId: string
    viewer?: DealViewer | null
    tx?: DatabaseClient
  }): Promise<DealTaskTemplateWithDeps[]> {
    const { workspaceId, pipelineId, viewer, tx = db } = props
    await pipelineService.findOrFail({
      workspaceId,
      id: pipelineId,
      viewer,
      tx,
    })
    const rows = await tx
      .select()
      .from(dealTaskTemplateModel)
      .where(
        and(
          eq(dealTaskTemplateModel.workspaceId, workspaceId),
          eq(dealTaskTemplateModel.pipelineId, pipelineId),
        ),
      )
      .orderBy(dealTaskTemplateModel.stageId, dealTaskTemplateModel.order)
    return await this.withDeps(rows, tx)
  }

  async upsert(props: {
    workspaceId: string
    pipelineId: string
    stageId: string
    templateId?: string | null
    data: DealTaskTemplateData
    viewer?: DealViewer | null
    tx?: DatabaseClient
  }): Promise<DealTaskTemplateWithDeps> {
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
      return (await this.withDeps([updated], tx))[0]
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
    return { ...created, dependsOn: [] }
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

  /**
   * Make template `templateId` wait on `dependsOnTemplateId`: both on the
   * named stage, per-template fan-in capped, a cycle refused by the same
   * bounded BFS as task edges. The per-stage advisory lock serialises two
   * inserts that would each pass the cycle check alone.
   */
  async addDependency(props: {
    workspaceId: string
    pipelineId: string
    stageId: string
    templateId: string
    dependsOnTemplateId: string
    viewer?: DealViewer | null
  }): Promise<DealTaskTemplateDependencyModel> {
    const {
      workspaceId,
      pipelineId,
      stageId,
      templateId,
      dependsOnTemplateId,
    } = props
    if (templateId === dependsOnTemplateId) {
      throw validationException(
        "dependsOnTemplateId",
        "A template cannot wait on itself.",
        { reason: "dependencySelf" },
      )
    }
    const row = await db.transaction(async (tx) => {
      await lockStageTemplates(tx, stageId)
      await pipelineService.resolveStage({
        workspaceId,
        pipelineId,
        stageId,
        viewer: props.viewer,
        tx,
      })
      const found = await tx
        .select({
          id: dealTaskTemplateModel.id,
          stageId: dealTaskTemplateModel.stageId,
        })
        .from(dealTaskTemplateModel)
        .where(
          and(
            eq(dealTaskTemplateModel.workspaceId, workspaceId),
            inArray(dealTaskTemplateModel.id, [
              templateId,
              dependsOnTemplateId,
            ]),
          ),
        )
      const own = found.find((t) => t.id === templateId)
      const other = found.find((t) => t.id === dependsOnTemplateId)
      if (!(own && other) || own.stageId !== stageId) {
        throw notFoundException(TEMPLATE_NOT_FOUND)
      }
      if (other.stageId !== stageId) {
        throw validationException(
          "dependsOnTemplateId",
          "A template can only wait on a template of the same stage.",
          { reason: "dependencyCrossStage" },
        )
      }
      const edges = (await this.stageEdges(tx, workspaceId, stageId)).map(
        (e) => ({
          taskId: e.templateId,
          dependsOnTaskId: e.dependsOnTemplateId,
        }),
      )
      const refusal = edgeRefusal({
        edges,
        taskId: templateId,
        dependsOnTaskId: dependsOnTemplateId,
        cap: MAX_DEAL_TASK_TEMPLATE_DEPENDENCIES_PER_TEMPLATE,
        field: "dependsOnTemplateId",
      })
      if (refusal) {
        throw validationException(
          "dependsOnTemplateId",
          TEMPLATE_EDGE_REFUSAL_MESSAGES[refusal],
          { reason: refusal },
        )
      }
      const [inserted] = await tx
        .insert(dealTaskTemplateDependencyModel)
        .values({
          id: createId(),
          workspaceId,
          templateId,
          dependsOnTemplateId,
        })
        .returning()
      return inserted
    })
    await this.audit("deal.task-template.dependency.add", row.id)
    return row
  }

  async removeDependency(props: {
    workspaceId: string
    pipelineId: string
    stageId: string
    templateId: string
    dependsOnTemplateId: string
    viewer?: DealViewer | null
  }): Promise<{ removed: boolean }> {
    const {
      workspaceId,
      pipelineId,
      stageId,
      templateId,
      dependsOnTemplateId,
    } = props
    // the same per-stage lock as addDependency: its cycle check never reads
    // an edge set that a remove is changing underneath it
    const deleted = await db.transaction(async (tx) => {
      await lockStageTemplates(tx, stageId)
      await pipelineService.resolveStage({
        workspaceId,
        pipelineId,
        stageId,
        viewer: props.viewer,
        tx,
      })
      return await tx
        .delete(dealTaskTemplateDependencyModel)
        .where(
          and(
            eq(dealTaskTemplateDependencyModel.workspaceId, workspaceId),
            eq(dealTaskTemplateDependencyModel.templateId, templateId),
            eq(
              dealTaskTemplateDependencyModel.dependsOnTemplateId,
              dependsOnTemplateId,
            ),
            // pinned to the named stage: a template id from another stage
            // (or pipeline) removes nothing
            inArray(
              dealTaskTemplateDependencyModel.templateId,
              tx
                .select({ id: dealTaskTemplateModel.id })
                .from(dealTaskTemplateModel)
                .where(eq(dealTaskTemplateModel.stageId, stageId)),
            ),
          ),
        )
        .returning({ id: dealTaskTemplateDependencyModel.id })
    })
    if (deleted.length > 0) {
      await this.audit("deal.task-template.dependency.remove", deleted[0].id)
    }
    return { removed: deleted.length > 0 }
  }

  private async stageEdges(
    tx: DatabaseClient,
    workspaceId: string,
    stageId: string,
  ): Promise<{ templateId: string; dependsOnTemplateId: string }[]> {
    return await tx
      .select({
        templateId: dealTaskTemplateDependencyModel.templateId,
        dependsOnTemplateId:
          dealTaskTemplateDependencyModel.dependsOnTemplateId,
      })
      .from(dealTaskTemplateDependencyModel)
      .innerJoin(
        dealTaskTemplateModel,
        eq(
          dealTaskTemplateModel.id,
          dealTaskTemplateDependencyModel.templateId,
        ),
      )
      .where(
        and(
          eq(dealTaskTemplateDependencyModel.workspaceId, workspaceId),
          eq(dealTaskTemplateModel.stageId, stageId),
        ),
      )
  }

  private async withDeps(
    rows: DealTaskTemplateModel[],
    tx: DatabaseClient,
  ): Promise<DealTaskTemplateWithDeps[]> {
    if (rows.length === 0) {
      return []
    }
    const edges = await tx
      .select({
        templateId: dealTaskTemplateDependencyModel.templateId,
        dependsOnTemplateId:
          dealTaskTemplateDependencyModel.dependsOnTemplateId,
      })
      .from(dealTaskTemplateDependencyModel)
      .where(
        inArray(
          dealTaskTemplateDependencyModel.templateId,
          rows.map((r) => r.id),
        ),
      )
    const byTemplate = new Map<string, string[]>()
    for (const e of edges) {
      const list = byTemplate.get(e.templateId) ?? []
      list.push(e.dependsOnTemplateId)
      byTemplate.set(e.templateId, list)
    }
    return rows.map((r) => ({ ...r, dependsOn: byTemplate.get(r.id) ?? [] }))
  }

  private async parse(props: {
    workspaceId: string
    data: DealTaskTemplateData
    tx: DatabaseClient
  }): Promise<{
    title: string
    description: string | null
    startInDays: number | null
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
    const startInDays = parseDayOffset(data.startInDays, "startInDays")
    const dueInDays = parseDayOffset(data.dueInDays, "dueInDays")
    if (startInDays !== null && dueInDays !== null && startInDays > dueInDays) {
      throw validationException(
        "startInDays",
        "startInDays must not be after dueInDays.",
        { reason: "startAfterDue" },
      )
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
    return {
      title,
      description,
      startInDays,
      dueInDays,
      assignToOwner,
      assigneeId,
    }
  }
}

function parseDayOffset(value: unknown, field: string): number | null {
  if (value === null || value === undefined) {
    return null
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_DEAL_TASK_DUE_IN_DAYS
  ) {
    throw validationException(
      field,
      `${field} must be an integer between 0 and ${MAX_DEAL_TASK_DUE_IN_DAYS}.`,
    )
  }
  return value
}

export const dealTaskTemplateService = new DealTaskTemplateService()

/** The per-stage lock every writer of template edges takes first. */
async function lockStageTemplates(
  tx: DatabaseClient,
  stageId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`tpl-deps:${stageId}`}))`,
  )
}
