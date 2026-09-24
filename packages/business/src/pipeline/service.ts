import {
  and,
  type DatabaseClient,
  db,
  eq,
  findOrFail,
  inArray,
  sql,
} from "@chatbotx.io/database/client"
import {
  DEFAULT_PIPELINE_STAGES,
  type PipelineSettings,
  type PipelineSettingsInput,
  pipelineSettingsSchema,
} from "@chatbotx.io/database/partials"
import {
  dealModel,
  pipelineModel,
  pipelineStageModel,
} from "@chatbotx.io/database/schema"
import type {
  PipelineModel,
  PipelineStageModel,
} from "@chatbotx.io/database/types"
import { createId } from "@chatbotx.io/utils"
import { BaseService } from "../base.service"
import {
  ChatbotXException,
  notFoundException,
  validationException,
} from "../errors"

export type PipelineStageData = {
  name: string
  color?: string | null
  probability?: number | null
  isWon?: boolean | null
  isLost?: boolean | null
}

export type PipelineData = {
  name: string
  settings?: PipelineSettingsInput | null
  /** Seeded on create only; omitted = the four default stages. */
  stages?: PipelineStageData[] | null
}

export type PipelineWithStages = PipelineModel & {
  stages: PipelineStageModel[]
}

const PIPELINE_NOT_FOUND = "Pipeline not found"
const STAGE_NOT_FOUND = "Stage not found"
export const STAGE_ORDER_STEP = 1000

/**
 * Pipelines and their stages. Edge-safe (no queue or scheduler imports);
 * deals live in `../deal` behind the `@chatbotx.io/business/deal` subpath
 * because they reach the company stop cascade.
 */
class PipelineService extends BaseService {
  async findOrFail(props: {
    workspaceId: string
    id: string
    tx?: DatabaseClient
  }): Promise<PipelineModel> {
    const { workspaceId, id, tx = db } = props
    return await findOrFail({
      client: tx,
      table: pipelineModel,
      where: { id, workspaceId },
      message: PIPELINE_NOT_FOUND,
    })
  }

  async find(props: {
    workspaceId: string
    id: string
    tx?: DatabaseClient
  }): Promise<PipelineWithStages> {
    const { workspaceId, id, tx = db } = props
    const pipeline = await this.findOrFail({ workspaceId, id, tx })
    const stages = await this.listStages({ pipelineId: id, tx })
    return { ...pipeline, stages }
  }

  /** Every pipeline of the workspace with its stages, in `order`. */
  async list(props: {
    workspaceId: string
    tx?: DatabaseClient
  }): Promise<PipelineWithStages[]> {
    const { workspaceId, tx = db } = props
    const pipelines = await tx.query.pipelineModel.findMany({
      where: { workspaceId },
      orderBy: { order: "asc", createdAt: "asc" },
    })
    if (pipelines.length === 0) {
      return []
    }
    const stages = await tx.query.pipelineStageModel.findMany({
      where: { pipelineId: { in: pipelines.map((p) => p.id) } },
      orderBy: { order: "asc", createdAt: "asc" },
    })
    const byPipeline = new Map<string, PipelineStageModel[]>()
    for (const stage of stages) {
      const list = byPipeline.get(stage.pipelineId) ?? []
      list.push(stage)
      byPipeline.set(stage.pipelineId, list)
    }
    return pipelines.map((p) => ({ ...p, stages: byPipeline.get(p.id) ?? [] }))
  }

  async listStages(props: {
    pipelineId: string
    tx?: DatabaseClient
  }): Promise<PipelineStageModel[]> {
    const { pipelineId, tx = db } = props
    return await tx.query.pipelineStageModel.findMany({
      where: { pipelineId },
      orderBy: { order: "asc", createdAt: "asc" },
    })
  }

  /** Parse + default the settings; unknown keys are rejected by the closed schema. */
  parseSettings(
    input: PipelineSettingsInput | null | undefined,
  ): PipelineSettings {
    const parsed = pipelineSettingsSchema.strict().safeParse(input ?? {})
    if (!parsed.success) {
      throw validationException(
        "settings",
        parsed.error.issues[0]?.message ?? "Invalid pipeline settings.",
      )
    }
    return parsed.data
  }

  async create(props: {
    workspaceId: string
    data: PipelineData
    tx?: DatabaseClient
  }): Promise<PipelineWithStages> {
    const { workspaceId, data, tx = db } = props
    const name = data.name.trim()
    if (name.length === 0) {
      throw validationException("name", "Name is required.")
    }
    const settings = this.parseSettings(data.settings)
    const stageInputs =
      data.stages && data.stages.length > 0
        ? data.stages
        : DEFAULT_PIPELINE_STAGES.map((s) => ({ ...s }))
    for (const stage of stageInputs) {
      this.assertStageData(stage)
    }

    const existing = await tx.query.pipelineModel.findFirst({
      columns: { id: true },
      where: { name, workspaceId },
    })
    if (existing) {
      throw new ChatbotXException("Name is already taken.", "nameTaken", 400)
    }
    const [{ maxOrder }] = await tx
      .select({ maxOrder: sql<number | null>`max(${pipelineModel.order})` })
      .from(pipelineModel)
      .where(eq(pipelineModel.workspaceId, workspaceId))

    const [pipeline] = await tx
      .insert(pipelineModel)
      .values({
        id: createId(),
        workspaceId,
        name,
        order: (Number(maxOrder) || 0) + STAGE_ORDER_STEP,
        // jsonb: written explicitly, never by a drizzle default (AGENTS.md)
        settings,
      })
      .returning()

    const stages = await tx
      .insert(pipelineStageModel)
      .values(
        stageInputs.map((stage, index) => ({
          id: createId(),
          pipelineId: pipeline.id,
          name: stage.name.trim(),
          order: (index + 1) * STAGE_ORDER_STEP,
          color: stage.color ?? null,
          probability: stage.probability ?? 0,
          isWon: stage.isWon ?? false,
          isLost: stage.isLost ?? false,
        })),
      )
      .returning()

    await this.audit("pipeline.create", pipeline.id)
    return { ...pipeline, stages }
  }

  async update(props: {
    workspaceId: string
    id: string
    data: Partial<Pick<PipelineData, "name" | "settings">>
    tx?: DatabaseClient
  }): Promise<PipelineWithStages> {
    const { workspaceId, id, data, tx = db } = props
    const current = await this.findOrFail({ workspaceId, id, tx })

    const set: Partial<typeof pipelineModel.$inferInsert> = {}
    if (data.name !== undefined) {
      const name = data.name.trim()
      if (name.length === 0) {
        throw validationException("name", "Name is required.")
      }
      const taken = await tx.query.pipelineModel.findFirst({
        columns: { id: true },
        where: { name, workspaceId, id: { ne: id } },
      })
      if (taken) {
        throw new ChatbotXException("Name is already taken.", "nameTaken", 400)
      }
      set.name = name
    }
    if (data.settings !== undefined && data.settings !== null) {
      set.settings = this.parseSettings({
        ...current.settings,
        ...data.settings,
      })
    }
    if (Object.keys(set).length > 0) {
      await tx
        .update(pipelineModel)
        .set(set)
        .where(
          and(
            eq(pipelineModel.id, id),
            eq(pipelineModel.workspaceId, workspaceId),
          ),
        )
      await this.audit("pipeline.update", id)
    }
    return await this.find({ workspaceId, id, tx })
  }

  /** `ids` in the wanted order; ids not in the list keep their place after them. */
  async reorder(props: {
    workspaceId: string
    ids: string[]
    tx?: DatabaseClient
  }): Promise<void> {
    const { workspaceId, ids, tx = db } = props
    const owned = await tx.query.pipelineModel.findMany({
      columns: { id: true },
      where: { workspaceId, id: { in: ids } },
    })
    if (owned.length !== new Set(ids).size) {
      throw notFoundException(PIPELINE_NOT_FOUND)
    }
    await Promise.all(
      ids.map((id, index) =>
        tx
          .update(pipelineModel)
          .set({ order: (index + 1) * STAGE_ORDER_STEP })
          .where(
            and(
              eq(pipelineModel.id, id),
              eq(pipelineModel.workspaceId, workspaceId),
            ),
          ),
      ),
    )
  }

  /**
   * Deleting a pipeline deletes its stages and deals (FK cascade). Refused
   * while open deals exist unless `force`, so a mis-click cannot wipe a board.
   */
  async remove(props: {
    workspaceId: string
    id: string
    force?: boolean
    tx?: DatabaseClient
  }): Promise<{ deletedDeals: number }> {
    const { workspaceId, id } = props
    const run = async (tx: DatabaseClient) => {
      await this.findOrFail({ workspaceId, id, tx })
      const openDeals = await tx.$count(
        dealModel,
        and(
          eq(dealModel.pipelineId, id),
          eq(dealModel.workspaceId, workspaceId),
          eq(dealModel.status, "open"),
        ),
      )
      if (openDeals > 0 && !props.force) {
        throw validationException(
          "id",
          `${openDeals} open deal(s) are still in this pipeline; close or move them first.`,
          { openDeals },
        )
      }
      // Deals go first, explicitly: `Deal.stageId` is RESTRICT, so the stage
      // cascade must never race the deal cascade (Postgres does not promise an
      // order between two FK cascades on the same parent).
      const deleted = await tx
        .delete(dealModel)
        .where(
          and(
            eq(dealModel.pipelineId, id),
            eq(dealModel.workspaceId, workspaceId),
          ),
        )
        .returning({ id: dealModel.id })
      await tx
        .delete(pipelineModel)
        .where(
          and(
            eq(pipelineModel.id, id),
            eq(pipelineModel.workspaceId, workspaceId),
          ),
        )
      return { deletedDeals: deleted.length }
    }
    const result = props.tx
      ? await run(props.tx)
      : await db.transaction(async (tx) => await run(tx))
    await this.audit("pipeline.delete", id)
    return result
  }

  /** The stage, guaranteed to belong to `pipelineId` of `workspaceId`. */
  async resolveStage(props: {
    workspaceId: string
    pipelineId: string
    stageId: string
    tx?: DatabaseClient
  }): Promise<PipelineStageModel> {
    const { workspaceId, pipelineId, stageId, tx = db } = props
    const [row] = await tx
      .select({ stage: pipelineStageModel })
      .from(pipelineStageModel)
      .innerJoin(
        pipelineModel,
        eq(pipelineModel.id, pipelineStageModel.pipelineId),
      )
      .where(
        and(
          eq(pipelineStageModel.id, stageId),
          eq(pipelineStageModel.pipelineId, pipelineId),
          eq(pipelineModel.workspaceId, workspaceId),
        ),
      )
      .limit(1)
    if (!row) {
      throw validationException("stageId", "Stage is not in this pipeline.", {
        pipelineId,
        stageId,
      })
    }
    return row.stage
  }

  /** The first stage in order, the default landing stage of a new deal. */
  async firstStage(props: {
    workspaceId: string
    pipelineId: string
    tx?: DatabaseClient
  }): Promise<PipelineStageModel> {
    const { workspaceId, pipelineId, tx = db } = props
    await this.findOrFail({ workspaceId, id: pipelineId, tx })
    const [stage] = await this.listStages({ pipelineId, tx })
    if (!stage) {
      throw validationException("pipelineId", "Pipeline has no stages.")
    }
    return stage
  }

  async upsertStage(props: {
    workspaceId: string
    pipelineId: string
    stageId?: string | null
    data: PipelineStageData
    tx?: DatabaseClient
  }): Promise<PipelineStageModel> {
    const { workspaceId, pipelineId, data, tx = db } = props
    await this.findOrFail({ workspaceId, id: pipelineId, tx })
    this.assertStageData(data)
    const values = {
      name: data.name.trim(),
      color: data.color ?? null,
      probability: data.probability ?? 0,
      isWon: data.isWon ?? false,
      isLost: data.isLost ?? false,
    }
    if (props.stageId) {
      await this.resolveStage({
        workspaceId,
        pipelineId,
        stageId: props.stageId,
        tx,
      })
      const [updated] = await tx
        .update(pipelineStageModel)
        .set(values)
        .where(eq(pipelineStageModel.id, props.stageId))
        .returning()
      if (!updated) {
        throw notFoundException(STAGE_NOT_FOUND)
      }
      await this.audit("pipeline.stage.update", updated.id)
      return updated
    }
    const [{ maxOrder }] = await tx
      .select({
        maxOrder: sql<number | null>`max(${pipelineStageModel.order})`,
      })
      .from(pipelineStageModel)
      .where(eq(pipelineStageModel.pipelineId, pipelineId))
    const [created] = await tx
      .insert(pipelineStageModel)
      .values({
        id: createId(),
        pipelineId,
        order: (Number(maxOrder) || 0) + STAGE_ORDER_STEP,
        ...values,
      })
      .returning()
    await this.audit("pipeline.stage.create", created.id)
    return created
  }

  async reorderStages(props: {
    workspaceId: string
    pipelineId: string
    stageIds: string[]
    tx?: DatabaseClient
  }): Promise<PipelineStageModel[]> {
    const { workspaceId, pipelineId, stageIds, tx = db } = props
    await this.findOrFail({ workspaceId, id: pipelineId, tx })
    const owned = await tx.query.pipelineStageModel.findMany({
      columns: { id: true },
      where: { pipelineId, id: { in: stageIds } },
    })
    if (owned.length !== new Set(stageIds).size) {
      throw validationException(
        "stageIds",
        "Every stage must belong to the pipeline.",
      )
    }
    await Promise.all(
      stageIds.map((id, index) =>
        tx
          .update(pipelineStageModel)
          .set({ order: (index + 1) * STAGE_ORDER_STEP })
          .where(eq(pipelineStageModel.id, id)),
      ),
    )
    return await this.listStages({ pipelineId, tx })
  }

  /**
   * Remove a stage. Deals in it are moved to `moveDealsTo` (another stage of
   * the same pipeline) first; without a target and with deals present the
   * call is refused (the FK is RESTRICT, so the database would refuse too).
   */
  async removeStage(props: {
    workspaceId: string
    pipelineId: string
    stageId: string
    moveDealsTo?: string | null
    tx?: DatabaseClient
  }): Promise<{ movedDeals: number }> {
    const { workspaceId, pipelineId, stageId, tx = db } = props
    await this.resolveStage({ workspaceId, pipelineId, stageId, tx })
    const stageCount = await tx.$count(
      pipelineStageModel,
      eq(pipelineStageModel.pipelineId, pipelineId),
    )
    if (stageCount <= 1) {
      throw validationException(
        "stageId",
        "A pipeline keeps at least one stage.",
      )
    }
    const dealCount = await tx.$count(
      dealModel,
      and(
        eq(dealModel.stageId, stageId),
        eq(dealModel.workspaceId, workspaceId),
      ),
    )
    let movedDeals = 0
    if (dealCount > 0) {
      if (!props.moveDealsTo || props.moveDealsTo === stageId) {
        throw validationException(
          "moveDealsTo",
          `${dealCount} deal(s) are in this stage; pick a stage to move them to.`,
          { dealCount },
        )
      }
      await this.resolveStage({
        workspaceId,
        pipelineId,
        stageId: props.moveDealsTo,
        tx,
      })
      const moved = await tx
        .update(dealModel)
        .set({ stageId: props.moveDealsTo })
        .where(
          and(
            eq(dealModel.stageId, stageId),
            eq(dealModel.workspaceId, workspaceId),
          ),
        )
        .returning({ id: dealModel.id })
      movedDeals = moved.length
    }
    await tx
      .delete(pipelineStageModel)
      .where(
        and(
          eq(pipelineStageModel.id, stageId),
          inArray(pipelineStageModel.pipelineId, [pipelineId]),
        ),
      )
    await this.audit("pipeline.stage.delete", stageId)
    return { movedDeals }
  }

  private assertStageData(data: PipelineStageData): void {
    if (typeof data.name !== "string" || data.name.trim().length === 0) {
      throw validationException("name", "Stage name is required.")
    }
    if (data.isWon && data.isLost) {
      throw validationException("isWon", "A stage is won or lost, not both.")
    }
    const probability = data.probability ?? 0
    if (
      !Number.isInteger(probability) ||
      probability < 0 ||
      probability > 100
    ) {
      throw validationException(
        "probability",
        "Probability is a whole number from 0 to 100.",
      )
    }
  }
}

export const pipelineService = new PipelineService()
