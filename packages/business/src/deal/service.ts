import {
  and,
  type DatabaseClient,
  db,
  desc,
  eq,
  findOrFail,
  inArray,
  relationsFilterToSQL,
  type SQL,
  sql,
} from "@chatbotx.io/database/client"
import {
  type DealActivityType,
  type DealFieldDef,
  type DealPriority,
  type DealStatus,
  dealPriorities,
  dealStatuses,
  normalizeDealValue,
  type PipelineSettings,
  validateDealFields,
} from "@chatbotx.io/database/partials"
import {
  contactModel,
  dealActivityModel,
  dealCommentModel,
  dealModel,
  dealTaskModel,
} from "@chatbotx.io/database/schema"
import type {
  DealActivityModel,
  DealModel,
  PipelineModel,
  PipelineStageModel,
} from "@chatbotx.io/database/types"
import {
  likeContains,
  parseOrderByAsObject,
  parsePagination,
} from "@chatbotx.io/database/utils"
import {
  type DealEventMetadata,
  emitDealCreated,
  emitDealMovedToStage,
  emitDealPriorityChanged,
  emitDealStatusChanged,
  emitDealValueChanged,
} from "@chatbotx.io/events"
import { createId } from "@chatbotx.io/utils"
import { DEAL_POSITION_STEP } from "@chatbotx.io/utils/deal-position"
import { BaseService } from "../base.service"
import { companyActivityService } from "../company/activity"
import { companyService } from "../company/service"
import { notFoundException, validationException } from "../errors"
import { logger } from "../logger"
import {
  canViewPipeline,
  type DealViewer,
  viewerOwnerFilter,
} from "../pipeline/access"
import { pipelineMemberService } from "../pipeline/members"
import { pipelineService } from "../pipeline/service"
import type { PaginatedResult } from "../types"
import { workspaceMemberService } from "../workspace-member/service"
import { stopCompanyForDeal } from "./company-stop"
import {
  dealEventMetadata,
  parseDateOrNull,
  resolveWorkspaceMember,
} from "./shared"
import { runStageEntered } from "./stage-hooks"

export type ListDealsInput = {
  workspaceId: string
  pipelineId?: string | null
  stageId?: string | null
  contactId?: string | null
  companyId?: string | null
  ownerId?: string | null
  status?: DealStatus | null
  title?: string | null
  page?: number | null
  perPage?: number | null
  sort?: { id: string; desc: boolean }[] | null
}

export type DealData = {
  title: string
  pipelineId: string
  stageId?: string | null
  value?: string | number | null
  currency?: string | null
  priority?: DealPriority | null
  contactId?: string | null
  companyId?: string | null
  ownerId?: string | null
  dueAt?: Date | null
  fields?: Record<string, unknown> | null
}

export type DealUpdateData = Partial<
  Pick<
    DealData,
    | "title"
    | "value"
    | "currency"
    | "priority"
    | "ownerId"
    | "dueAt"
    | "fields"
    // s195 CRM 360: re-link after creation
    | "contactId"
    | "companyId"
  >
>

/** Per-deal task / comment counts on a board card (s198). */
export type DealCardCounts = {
  openTaskCount: number
  overdueTaskCount: number
  commentCount: number
}
export type BoardDeal = DealModel & DealCardCounts
export type BoardColumn = { stage: PipelineStageModel; deals: BoardDeal[] }

const NO_COUNTS: DealCardCounts = {
  openTaskCount: 0,
  overdueTaskCount: 0,
  commentCount: 0,
}
const DEAL_NOT_FOUND = "Deal not found"
const ISO_CURRENCY = /^[A-Z]{3}$/

/** 409-class: the row moved under us; the caller reloads and retries. */
const dealChangedConcurrently = () =>
  validationException(
    "id",
    "Deal was changed by someone else; reload and retry.",
    { conflict: "stale" },
  )
/** A deal landing on a stage takes its status: won / lost stages close it, any other opens it. */
const landingStatus = (stage: PipelineStageModel): DealStatus => {
  if (stage.isWon) {
    return "won"
  }
  return stage.isLost ? "lost" : "open"
}
/** Open clears `closedAt`; staying closed keeps it; closing now stamps it. */
const landingClosedAt = (
  status: DealStatus,
  current: Pick<DealModel, "status" | "closedAt">,
): Date | null => {
  if (status === "open") {
    return null
  }
  return status === current.status ? current.closedAt : new Date()
}
/** Below this gap two neighbouring positions are renormalised to `DEAL_POSITION_STEP * i`. */
export const MIN_POSITION_GAP = 1e-6

/**
 * Deals. Node-only (`@chatbotx.io/business/deal`): creating or winning a deal
 * can run the company stop cascade, which reaches the sequence scheduler.
 *
 * Write order on every mutation: the row + its activity inside one
 * transaction, THEN the trigger event, THEN the company stop. An emit or a
 * stop failure never un-does the write.
 */
class DealService extends BaseService {
  /**
   * With a `viewer` (s193) a deal the viewer may not read is a 404, never a
   * 403 (no existence leak): the pipeline must be visible to them and, for an
   * `onlyAssignedContacts` member, the deal must be theirs. Callers without a
   * viewer (workers, the public API, internal hooks) are unscoped.
   */
  async findOrFail(props: {
    workspaceId: string
    id: string
    viewer?: DealViewer | null
    tx?: DatabaseClient
  }): Promise<DealModel> {
    const { workspaceId, id, viewer, tx = db } = props
    const deal = await findOrFail({
      client: tx,
      table: dealModel,
      where: { id, workspaceId },
      message: DEAL_NOT_FOUND,
    })
    if (viewer) {
      await this.assertViewer({ deal, viewer, tx })
    }
    return deal
  }

  private async assertViewer(props: {
    deal: DealModel
    viewer: DealViewer
    tx: DatabaseClient
  }): Promise<void> {
    const { deal, viewer, tx } = props
    const pipeline = await pipelineService.findOrFail({
      workspaceId: deal.workspaceId,
      id: deal.pipelineId,
      tx,
    })
    if (!(await canViewPipeline({ viewer, pipeline, tx }))) {
      throw notFoundException(DEAL_NOT_FOUND)
    }
    const ownerFilter = viewerOwnerFilter(viewer)
    if (ownerFilter !== undefined && deal.ownerId !== ownerFilter) {
      throw notFoundException(DEAL_NOT_FOUND)
    }
  }

  async list(
    input: ListDealsInput & { viewer?: DealViewer | null },
  ): Promise<PaginatedResult<DealModel>> {
    const ownerFilter = input.viewer
      ? viewerOwnerFilter(input.viewer)
      : undefined
    const visible = await pipelineService.visibleIds({
      workspaceId: input.workspaceId,
      viewer: input.viewer,
    })
    if (
      visible !== null &&
      ((input.pipelineId && !visible.includes(input.pipelineId)) ||
        visible.length === 0)
    ) {
      return { data: [], pageCount: 1 }
    }
    const where = {
      workspaceId: input.workspaceId,
      pipelineId:
        input.pipelineId ?? (visible === null ? undefined : { in: visible }),
      stageId: input.stageId ?? undefined,
      contactId: input.contactId ?? undefined,
      companyId: input.companyId ?? undefined,
      ownerId: ownerFilter ?? input.ownerId ?? undefined,
      status: input.status ?? undefined,
      title: input.title ? { ilike: likeContains(input.title) } : undefined,
    }
    const requestedOrderBy = parseOrderByAsObject(dealModel, input)
    const orderBy =
      Object.keys(requestedOrderBy).length > 0
        ? requestedOrderBy
        : { createdAt: "desc" as const }
    const pagination = parsePagination(input)
    const [data, total] = await Promise.all([
      db.query.dealModel.findMany({ where, orderBy, ...pagination }),
      db.$count(dealModel, relationsFilterToSQL(dealModel, where)),
    ])
    const pageCount = pagination?.limit
      ? Math.ceil(total / pagination.limit)
      : 1
    return { data, pageCount }
  }

  /** Every stage of the pipeline with its deals ordered by `position`. */
  async listBoard(props: {
    workspaceId: string
    pipelineId: string
    status?: DealStatus | "all" | null
    viewer?: DealViewer | null
    tx?: DatabaseClient
  }): Promise<BoardColumn[]> {
    const { workspaceId, pipelineId, viewer, tx = db } = props
    const status = props.status ?? "all"
    const pipeline = await pipelineService.find({
      workspaceId,
      id: pipelineId,
      viewer,
      tx,
    })
    const ownerId = viewer ? viewerOwnerFilter(viewer) : undefined
    const deals = await tx.query.dealModel.findMany({
      where: {
        workspaceId,
        pipelineId,
        status: status === "all" ? undefined : status,
        ownerId,
      },
      orderBy: { position: "asc", createdAt: "asc" },
    })
    const counts =
      deals.length > 0
        ? await this.boardCounts({
            tx,
            // the same Deal predicates as the board query above
            dealWhere: and(
              eq(dealModel.workspaceId, workspaceId),
              eq(dealModel.pipelineId, pipelineId),
              status === "all" ? undefined : eq(dealModel.status, status),
              ownerId === undefined
                ? undefined
                : eq(dealModel.ownerId, ownerId),
            ),
          })
        : new Map<string, DealCardCounts>()
    const byStage = new Map<string, BoardDeal[]>()
    for (const deal of deals) {
      const list = byStage.get(deal.stageId) ?? []
      list.push({ ...deal, ...(counts.get(deal.id) ?? NO_COUNTS) })
      byStage.set(deal.stageId, list)
    }
    return pipeline.stages.map((stage) => ({
      stage,
      deals: byStage.get(stage.id) ?? [],
    }))
  }

  /**
   * Open / overdue task and comment counts of the deals matching `dealWhere`,
   * one grouped query each, joined through Deal (a board has no size cap, so
   * never an id list). Deals with none are absent from the map.
   */
  private async boardCounts(props: {
    tx: DatabaseClient
    dealWhere: SQL | undefined
  }): Promise<Map<string, DealCardCounts>> {
    const { tx, dealWhere } = props
    const [tasks, comments] = await Promise.all([
      tx
        .select({
          dealId: dealTaskModel.dealId,
          open: sql<number>`(count(*) filter (where ${dealTaskModel.status} = 'open'))::int`,
          overdue: sql<number>`(count(*) filter (where ${dealTaskModel.status} = 'open' and ${dealTaskModel.dueAt} < now()))::int`,
        })
        .from(dealTaskModel)
        .innerJoin(dealModel, eq(dealModel.id, dealTaskModel.dealId))
        .where(dealWhere)
        .groupBy(dealTaskModel.dealId),
      tx
        .select({
          dealId: dealCommentModel.dealId,
          count: sql<number>`count(*)::int`,
        })
        .from(dealCommentModel)
        .innerJoin(dealModel, eq(dealModel.id, dealCommentModel.dealId))
        .where(dealWhere)
        .groupBy(dealCommentModel.dealId),
    ])
    const out = new Map<string, DealCardCounts>()
    const entry = (dealId: string) => {
      const found = out.get(dealId)
      if (found) {
        return found
      }
      const fresh = { ...NO_COUNTS }
      out.set(dealId, fresh)
      return fresh
    }
    for (const row of tasks) {
      const counts = entry(row.dealId)
      counts.openTaskCount = Number(row.open)
      counts.overdueTaskCount = Number(row.overdue)
    }
    for (const row of comments) {
      entry(row.dealId).commentCount = Number(row.count)
    }
    return out
  }

  async listByContactId(props: {
    workspaceId: string
    contactId: string
    tx?: DatabaseClient
  }): Promise<DealModel[]> {
    const { workspaceId, contactId, tx = db } = props
    return await tx.query.dealModel.findMany({
      where: { workspaceId, contactId },
      orderBy: { createdAt: "desc" },
    })
  }

  async findOpenForContactInPipeline(props: {
    workspaceId: string
    contactId: string
    pipelineId: string
    tx?: DatabaseClient
  }): Promise<DealModel | undefined> {
    const { workspaceId, contactId, pipelineId, tx = db } = props
    return await tx.query.dealModel.findFirst({
      where: { workspaceId, contactId, pipelineId, status: "open" },
      orderBy: { createdAt: "desc" },
    })
  }

  async listActivities(props: {
    workspaceId: string
    dealId: string
    limit?: number
    viewer?: DealViewer | null
    tx?: DatabaseClient
  }): Promise<DealActivityModel[]> {
    const { workspaceId, dealId, viewer, limit = 200, tx = db } = props
    await this.findOrFail({ workspaceId, id: dealId, viewer, tx })
    return await tx
      .select()
      .from(dealActivityModel)
      .where(eq(dealActivityModel.dealId, dealId))
      .orderBy(desc(dealActivityModel.createdAt))
      .limit(limit)
  }

  /**
   * With a `viewer` (s193): the pipeline must be visible to them (else 404)
   * and an `onlyAssignedContacts` member who names no owner becomes the owner
   * (otherwise they could create a deal they can never see again).
   */
  async create(props: {
    workspaceId: string
    data: DealData
    actorId?: string | null
    viewer?: DealViewer | null
  }): Promise<DealModel> {
    const { workspaceId, viewer } = props
    const actorId = props.actorId ?? null
    const ownerFilter = viewer ? viewerOwnerFilter(viewer) : undefined
    const data =
      ownerFilter !== undefined && props.data.ownerId === undefined
        ? { ...props.data, ownerId: ownerFilter }
        : props.data
    const parsed = this.parseCreateData(data)
    const { deal, settings } = await db.transaction(
      async (tx) =>
        await this.insertInTx({
          tx,
          workspaceId,
          data,
          parsed,
          actorId,
          viewer,
        }),
    )
    await this.afterCreate(deal, settings, actorId)
    return deal
  }

  /**
   * `create`, but at most ONE open deal per contact per pipeline: the check and
   * the insert run under a transaction-scoped advisory lock keyed on the
   * contact + pipeline, so two concurrent flow runs cannot both pass the
   * "no open deal yet" check (the flow step's `skipIfOpenDealExists`).
   */
  async createUnlessOpen(props: {
    workspaceId: string
    data: DealData & { contactId: string }
    actorId?: string | null
  }): Promise<{ deal: DealModel; created: boolean }> {
    const { workspaceId, data } = props
    const actorId = props.actorId ?? null
    const parsed = this.parseCreateData(data)
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`deal:${workspaceId}:${data.contactId}:${data.pipelineId}`}))`,
      )
      const existing = await this.findOpenForContactInPipeline({
        workspaceId,
        contactId: data.contactId,
        pipelineId: data.pipelineId,
        tx,
      })
      if (existing) {
        return { created: false as const, deal: existing }
      }
      const inserted = await this.insertInTx({
        tx,
        workspaceId,
        data,
        parsed,
        actorId,
      })
      return { created: true as const, ...inserted }
    })
    if (outcome.created) {
      await this.afterCreate(outcome.deal, outcome.settings, actorId)
    }
    return { deal: outcome.deal, created: outcome.created }
  }

  private parseCreateData(data: DealData): {
    title: string
    value: string | null
    priority: DealPriority
  } {
    const title = typeof data.title === "string" ? data.title.trim() : ""
    if (title.length === 0) {
      throw validationException("title", "Title is required.")
    }
    return {
      title,
      value: this.parseValue(data.value),
      priority: this.parsePriority(data.priority) ?? "medium",
    }
  }

  /** Event, audit and the company stop AFTER the row committed. */
  private async afterCreate(
    deal: DealModel,
    settings: PipelineSettings,
    actorId: string | null = null,
  ): Promise<void> {
    await this.audit("deal.create", deal.id)
    await companyActivityService.recordSafely({
      workspaceId: deal.workspaceId,
      companyId: deal.companyId,
      type: "dealCreated",
      actorId,
      payload: { dealId: deal.id, title: deal.title, stageId: deal.stageId },
    })
    await this.emitFor(deal, emitDealCreated, {})
    // A deal created straight into a won stage IS won: the `won` rule applies
    // here too, not only through setStatus.
    const stops =
      settings.stopCompanyOn === "created" ||
      (settings.stopCompanyOn === "won" && deal.status === "won")
    if (stops && deal.companyId) {
      await stopCompanyForDeal({
        workspaceId: deal.workspaceId,
        companyId: deal.companyId,
        dealId: deal.id,
        contactId: deal.contactId,
      })
    }
    await runStageEntered({
      workspaceId: deal.workspaceId,
      deal,
      stageId: deal.stageId,
      actorId,
    })
  }

  private async insertInTx(props: {
    tx: DatabaseClient
    workspaceId: string
    data: DealData
    parsed: { title: string; value: string | null; priority: DealPriority }
    actorId: string | null
    viewer?: DealViewer | null
  }): Promise<{ deal: DealModel; settings: PipelineSettings }> {
    const { tx, workspaceId, data, actorId } = props
    const { title, value, priority } = props.parsed
    {
      const pipeline = await pipelineService.findOrFail({
        workspaceId,
        id: data.pipelineId,
        viewer: props.viewer,
        tx,
      })
      const stage = data.stageId
        ? await pipelineService.resolveStage({
            workspaceId,
            pipelineId: pipeline.id,
            stageId: data.stageId,
            tx,
          })
        : await pipelineService.firstStage({
            workspaceId,
            pipelineId: pipeline.id,
            tx,
          })
      const contact = data.contactId
        ? await this.resolveContact({
            workspaceId,
            contactId: data.contactId,
            tx,
          })
        : null
      const companyId =
        data.companyId !== undefined && data.companyId !== null
          ? data.companyId
          : (contact?.companyId ?? null)
      // s193: no owner named + round-robin on = the next in-rotation member
      // (cursor advanced under the pipeline row lock, in THIS transaction).
      // An explicit `ownerId: null` keeps the deal ownerless on purpose.
      const ownerId = await this.resolveCreateOwner({
        workspaceId,
        ownerId: data.ownerId,
        settings: pipeline.settings,
        pipelineId: pipeline.id,
        tx,
      })
      const currency = this.parseCurrency(
        data.currency ?? pipeline.settings.defaultCurrency,
      )
      const position = await this.nextPosition({ stageId: stage.id, tx })
      const fields = this.parseFields({
        defs: pipeline.settings.fieldDefs,
        fields: data.fields ?? {},
        requireAll: true,
      })
      const status = landingStatus(stage)

      const [row] = await tx
        .insert(dealModel)
        .values({
          id: createId(),
          workspaceId,
          pipelineId: pipeline.id,
          stageId: stage.id,
          title,
          value,
          currency,
          status,
          priority,
          position,
          dueAt: data.dueAt ?? null,
          closedAt: status === "open" ? null : new Date(),
          contactId: contact?.id ?? null,
          companyId,
          ownerId,
          // jsonb: written explicitly, never by a drizzle default (AGENTS.md)
          fields,
        })
        .returning()
      await this.recordActivity({
        tx,
        dealId: row.id,
        type: "created",
        actorId,
        payload: { stageId: stage.id, status },
      })
      return { deal: row, settings: pipeline.settings }
    }
  }

  /** Title / value / currency / priority / owner / dueAt / fields; each change is one activity + one event. */
  async update(props: {
    workspaceId: string
    id: string
    data: DealUpdateData
    actorId?: string | null
    viewer?: DealViewer | null
  }): Promise<DealModel> {
    const { workspaceId, id, data, viewer } = props
    const actorId = props.actorId ?? null
    const set: Partial<typeof dealModel.$inferInsert> = {}
    const changes: {
      type: DealActivityType
      from: unknown
      to: unknown
      key?: string
    }[] = []

    const result = await db.transaction(async (tx) => {
      const current = await this.findOrFail({ workspaceId, id, viewer, tx })
      if (data.title !== undefined) {
        const title = typeof data.title === "string" ? data.title.trim() : ""
        if (title.length === 0) {
          throw validationException("title", "Title is required.")
        }
        if (title !== current.title) {
          set.title = title
          changes.push({ type: "titleChanged", from: current.title, to: title })
        }
      }
      if (data.value !== undefined) {
        const value = this.parseValue(data.value)
        if (value !== current.value) {
          set.value = value
          changes.push({ type: "valueChanged", from: current.value, to: value })
        }
      }
      if (data.currency !== undefined && data.currency !== null) {
        const currency = this.parseCurrency(data.currency)
        if (currency !== current.currency) {
          set.currency = currency
          changes.push({
            type: "currencyChanged",
            from: current.currency,
            to: currency,
          })
        }
      }
      if (data.priority !== undefined && data.priority !== null) {
        const priority = this.parsePriority(data.priority)
        if (priority && priority !== current.priority) {
          set.priority = priority
          changes.push({
            type: "priorityChanged",
            from: current.priority,
            to: priority,
          })
        }
      }
      if (data.ownerId !== undefined) {
        const ownerId = await this.resolveOwner({
          workspaceId,
          ownerId: data.ownerId,
          tx,
        })
        if (ownerId !== current.ownerId) {
          set.ownerId = ownerId
          changes.push({ type: "assigned", from: current.ownerId, to: ownerId })
        }
      }
      if (data.dueAt !== undefined) {
        const dueAt = this.parseDueAt(data.dueAt)
        if ((dueAt?.getTime() ?? null) !== (current.dueAt?.getTime() ?? null)) {
          set.dueAt = dueAt
          changes.push({
            type: "dueAtChanged",
            from: current.dueAt?.toISOString() ?? null,
            to: dueAt?.toISOString() ?? null,
          })
        }
      }
      if (data.fields !== undefined && data.fields !== null) {
        const pipeline = await pipelineService.findOrFail({
          workspaceId,
          id: current.pipelineId,
          tx,
        })
        // Type-check ONLY the keys in the patch (an array or string would
        // spread into keys, so the patch is checked as an object first). The
        // merged object gets the size caps alone: a stored value that no
        // longer matches an edited fieldDef must not block an unrelated edit.
        this.parseFields({
          defs: pipeline.settings.fieldDefs,
          fields: data.fields,
        })
        const merged = this.parseFields({
          defs: [],
          fields: { ...current.fields, ...data.fields },
        })
        for (const key of Object.keys(data.fields)) {
          const before = current.fields[key] ?? null
          const after = merged[key] ?? null
          if (JSON.stringify(before) !== JSON.stringify(after)) {
            changes.push({ type: "fieldChanged", from: before, to: after, key })
          }
        }
        if (changes.some((c) => c.type === "fieldChanged")) {
          set.fields = merged
        }
      }
      if (data.contactId !== undefined) {
        const contactId =
          data.contactId === null
            ? null
            : (
                await this.resolveContact({
                  workspaceId,
                  contactId: data.contactId,
                  tx,
                })
              ).id
        if (contactId !== current.contactId) {
          set.contactId = contactId
          changes.push({
            type: "contactChanged",
            from: current.contactId,
            to: contactId,
          })
        }
      }
      if (data.companyId !== undefined) {
        const companyId =
          data.companyId === null
            ? null
            : (
                await companyService.findOrFail({
                  workspaceId,
                  id: data.companyId,
                  tx,
                })
              ).id
        if (companyId !== current.companyId) {
          set.companyId = companyId
          changes.push({
            type: "companyChanged",
            from: current.companyId,
            to: companyId,
          })
        }
      }
      if (Object.keys(set).length === 0) {
        return { deal: current, changed: false }
      }
      const [updated] = await tx
        .update(dealModel)
        .set(set)
        .where(
          and(eq(dealModel.id, id), eq(dealModel.workspaceId, workspaceId)),
        )
        .returning()
      if (!updated) {
        throw notFoundException(DEAL_NOT_FOUND)
      }
      for (const change of changes) {
        await this.recordActivity({
          tx,
          dealId: id,
          type: change.type,
          actorId,
          payload:
            change.key === undefined
              ? { from: change.from, to: change.to }
              : { key: change.key, from: change.from, to: change.to },
        })
      }
      return { deal: updated, changed: true }
    })

    if (!result.changed) {
      return result.deal
    }
    await this.audit("deal.update", id)
    for (const change of changes) {
      if (change.type === "companyChanged") {
        await companyActivityService.recordSafely({
          workspaceId,
          companyId: change.to as string | null,
          type: "dealLinked",
          actorId,
          payload: { dealId: id, title: result.deal.title },
        })
      }
      if (change.type === "valueChanged") {
        await this.emitFor(result.deal, emitDealValueChanged, {
          oldValue: change.from as string | null,
        })
      } else if (change.type === "priorityChanged") {
        await this.emitFor(result.deal, emitDealPriorityChanged, {
          oldPriority: change.from as string,
        })
      }
    }
    return result.deal
  }

  /**
   * Move a deal to a stage of ITS pipeline. Same stage = reposition only (no
   * activity, no event). A won/lost stage also closes the deal through
   * `setStatus`; a normal stage reopens a closed deal.
   */
  async moveStage(props: {
    workspaceId: string
    id: string
    stageId: string
    position?: number | null
    actorId?: string | null
    viewer?: DealViewer | null
  }): Promise<DealModel> {
    const { workspaceId, id, stageId, viewer } = props
    const actorId = props.actorId ?? null

    const outcome = await db.transaction(async (tx) => {
      const current = await this.findOrFail({ workspaceId, id, viewer, tx })
      const stage = await pipelineService.resolveStage({
        workspaceId,
        pipelineId: current.pipelineId,
        stageId,
        tx,
      })
      const position =
        props.position !== undefined && props.position !== null
          ? this.parsePosition(props.position)
          : await this.nextPosition({ stageId: stage.id, tx })
      if (stage.id === current.stageId) {
        const [repositioned] = await tx
          .update(dealModel)
          .set({ position })
          .where(eq(dealModel.id, id))
          .returning()
        return { kind: "same" as const, deal: repositioned ?? current, stage }
      }
      // The predicate pins the stage this transaction read: a concurrent move
      // that already changed it makes this UPDATE touch 0 rows, so the
      // activity row and the event can never record a transition that did
      // not happen in that order.
      const [moved] = await tx
        .update(dealModel)
        .set({ stageId: stage.id, position })
        .where(
          and(
            eq(dealModel.id, id),
            eq(dealModel.workspaceId, workspaceId),
            eq(dealModel.stageId, current.stageId),
          ),
        )
        .returning()
      if (!moved) {
        throw dealChangedConcurrently()
      }
      await this.recordActivity({
        tx,
        dealId: id,
        type: "stageMoved",
        actorId,
        payload: { from: current.stageId, to: stage.id },
      })
      return {
        kind: "moved" as const,
        deal: moved,
        stage,
        fromStageId: current.stageId,
      }
    })

    if (outcome.kind === "same") {
      await this.maybeRenormalize({ stageId: outcome.stage.id })
      return outcome.deal
    }
    await this.audit("deal.move", id)
    await companyActivityService.recordSafely({
      workspaceId,
      companyId: outcome.deal.companyId,
      type: "dealMoved",
      actorId,
      payload: {
        dealId: id,
        title: outcome.deal.title,
        from: outcome.fromStageId,
        to: outcome.stage.id,
      },
    })
    await this.emitFor(outcome.deal, emitDealMovedToStage, {
      fromStageId: outcome.fromStageId,
    })
    await this.maybeRenormalize({ stageId: outcome.stage.id })
    await runStageEntered({
      workspaceId,
      deal: outcome.deal,
      stageId: outcome.stage.id,
      actorId,
    })

    const target = landingStatus(outcome.stage)
    if (target !== outcome.deal.status) {
      return await this.setStatus({ workspaceId, id, status: target, actorId })
    }
    return outcome.deal
  }

  /**
   * Move a deal to ANOTHER pipeline (s196): the target stage (default: its
   * first), the deal's fields re-validated against the TARGET `fieldDefs`
   * with every required key present (`fields` patches what is missing), and
   * an owner who can still see the target pipeline (`ownerId` reassigns,
   * null clears). Tasks, comments and notifications stay with the deal; the
   * target stage's task templates run, the landing status follows the stage
   * (written in the move's own transaction; the target's `stopCompanyOn`
   * applies), and `ticketMovedToStage` fires
   * for the destination stage with `fromPipelineId`. The same pipeline is a
   * 422 (that is `moveStage`). Landing OPEN in a pipeline where the contact already
   * has an open deal is refused (one open deal per contact per pipeline,
   * under `createUnlessOpen`'s lock).
   */
  async movePipeline(props: {
    workspaceId: string
    id: string
    pipelineId: string
    stageId?: string | null
    fields?: Record<string, unknown> | null
    ownerId?: string | null
    actorId?: string | null
    viewer?: DealViewer | null
  }): Promise<DealModel> {
    const { workspaceId, id, viewer } = props
    const actorId = props.actorId ?? null
    if (
      props.fields !== undefined &&
      props.fields !== null &&
      (typeof props.fields !== "object" || Array.isArray(props.fields))
    ) {
      throw validationException("fields", "Fields must be an object.")
    }

    const outcome = await db.transaction(async (tx) => {
      // Row lock FIRST (codex probe s196): every decision below (contact ->
      // lock key, status, owner, fields) reads the committed row, and a
      // concurrent write to this deal waits for the move instead of
      // interleaving. Order = row lock, then the advisory lock: no cycle with
      // createUnlessOpen, which never locks an existing deal row.
      await tx
        .select({ id: dealModel.id })
        .from(dealModel)
        .where(
          and(eq(dealModel.id, id), eq(dealModel.workspaceId, workspaceId)),
        )
        .for("update")
      const current = await this.findOrFail({ workspaceId, id, viewer, tx })
      if (current.pipelineId === props.pipelineId) {
        throw validationException(
          "pipelineId",
          "The deal is already in that pipeline; move it to a stage instead.",
        )
      }
      const target = await pipelineService.findOrFail({
        workspaceId,
        id: props.pipelineId,
        viewer,
        tx,
      })
      const stage = props.stageId
        ? await pipelineService.resolveStage({
            workspaceId,
            pipelineId: target.id,
            stageId: props.stageId,
            tx,
          })
        : await pipelineService.firstStage({
            workspaceId,
            pipelineId: target.id,
            tx,
          })
      const fields = this.parseFields({
        defs: target.settings.fieldDefs,
        fields: { ...current.fields, ...(props.fields ?? {}) },
        requireAll: true,
      })
      const ownerId =
        props.ownerId === undefined
          ? current.ownerId
          : await this.resolveOwner({ workspaceId, ownerId: props.ownerId, tx })
      await this.assertOwnerCanView({ workspaceId, ownerId, target, tx })

      // The landing status is written in THIS transaction, under the lock:
      // a deferred setStatus would reopen a closed deal after the lock is
      // gone (skeptic s196), and would refuse won -> lost after the move.
      const status = landingStatus(stage)
      if (status === "open" && current.contactId) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`deal:${workspaceId}:${current.contactId}:${target.id}`}))`,
        )
        const existing = await this.findOpenForContactInPipeline({
          workspaceId,
          contactId: current.contactId,
          pipelineId: target.id,
          tx,
        })
        if (existing) {
          throw validationException(
            "pipelineId",
            "The contact already has an open deal in that pipeline.",
            { conflict: "openDeal", dealId: existing.id },
          )
        }
      }

      const position = await this.nextPosition({ stageId: stage.id, tx })
      // Belt to the row lock: pinned to the pipeline, stage and status this
      // transaction read, so it can never record a transition that did not
      // happen in that order (same rule as `moveStage`).
      const [moved] = await tx
        .update(dealModel)
        .set({
          pipelineId: target.id,
          stageId: stage.id,
          position,
          fields,
          ownerId,
          status,
          closedAt: landingClosedAt(status, current),
        })
        .where(
          and(
            eq(dealModel.id, id),
            eq(dealModel.workspaceId, workspaceId),
            eq(dealModel.pipelineId, current.pipelineId),
            eq(dealModel.stageId, current.stageId),
            eq(dealModel.status, current.status),
          ),
        )
        .returning()
      if (!moved) {
        throw dealChangedConcurrently()
      }
      await this.recordActivity({
        tx,
        dealId: id,
        type: "pipelineMoved",
        actorId,
        payload: {
          fromPipelineId: current.pipelineId,
          toPipelineId: target.id,
          from: current.stageId,
          to: stage.id,
        },
      })
      if (ownerId !== current.ownerId) {
        await this.recordActivity({
          tx,
          dealId: id,
          type: "assigned",
          actorId,
          payload: { from: current.ownerId, to: ownerId },
        })
      }
      if (status !== current.status) {
        await this.recordActivity({
          tx,
          dealId: id,
          type: "statusChanged",
          actorId,
          payload: { from: current.status, to: status },
        })
      }
      return {
        deal: moved,
        oldStatus: current.status,
        status,
        settings: target.settings,
        stage,
        fromPipelineId: current.pipelineId,
        fromStageId: current.stageId,
      }
    })

    await this.audit("deal.move-pipeline", id)
    await companyActivityService.recordSafely({
      workspaceId,
      companyId: outcome.deal.companyId,
      type: "dealMoved",
      actorId,
      payload: {
        dealId: id,
        title: outcome.deal.title,
        from: outcome.fromStageId,
        to: outcome.stage.id,
        fromPipelineId: outcome.fromPipelineId,
        toPipelineId: outcome.deal.pipelineId,
      },
    })
    await this.emitFor(outcome.deal, emitDealMovedToStage, {
      fromStageId: outcome.fromStageId,
      fromPipelineId: outcome.fromPipelineId,
    })
    await this.maybeRenormalize({ stageId: outcome.stage.id })
    await runStageEntered({
      workspaceId,
      deal: outcome.deal,
      stageId: outcome.stage.id,
      actorId,
    })

    if (outcome.status !== outcome.oldStatus) {
      await this.afterStatusChange({
        deal: outcome.deal,
        oldStatus: outcome.oldStatus,
        status: outcome.status,
        settings: outcome.settings,
        actorId,
      })
    }
    return outcome.deal
  }

  /**
   * The owner must still be able to see the pipeline the deal moves into (a
   * members-only target hides it from non-members, super admins excepted):
   * a 422 the caller answers by reassigning (`ownerId`) or clearing it.
   */
  private async assertOwnerCanView(props: {
    workspaceId: string
    ownerId: string | null
    target: PipelineModel
    tx: DatabaseClient
  }): Promise<void> {
    const { workspaceId, ownerId, target, tx } = props
    if (!ownerId || target.settings.access !== "members") {
      return
    }
    const member = await workspaceMemberService.findByWorkspaceIdAndUserId({
      workspaceId,
      userId: ownerId,
      tx,
    })
    const visible =
      member !== undefined &&
      (await canViewPipeline({
        viewer: { userId: ownerId, permissions: member.permissions },
        pipeline: target,
        tx,
      }))
    if (!visible) {
      throw validationException(
        "ownerId",
        "The owner is not a member of the target pipeline; pick another owner.",
        { code: "ownerNotMember" },
      )
    }
  }

  /**
   * Open -> won|lost closes; won|lost -> open reopens; won <-> lost is refused
   * ("reopen first"); the same status is a no-op (one activity, one event at
   * most per real change). Winning a deal stops the company when the pipeline
   * says `stopCompanyOn: won`.
   */
  async setStatus(props: {
    workspaceId: string
    id: string
    status: DealStatus
    actorId?: string | null
    viewer?: DealViewer | null
  }): Promise<DealModel> {
    const { workspaceId, id, viewer } = props
    const actorId = props.actorId ?? null
    const status = this.parseStatus(props.status)

    const outcome = await db.transaction(async (tx) => {
      const current = await this.findOrFail({ workspaceId, id, viewer, tx })
      if (current.status === status) {
        return { changed: false as const, deal: current }
      }
      if (current.status !== "open" && status !== "open") {
        throw validationException(
          "status",
          `Deal is ${current.status}; reopen it before marking it ${status}.`,
          { from: current.status, to: status },
        )
      }
      const [updated] = await tx
        .update(dealModel)
        .set({ status, closedAt: status === "open" ? null : new Date() })
        .where(
          and(
            eq(dealModel.id, id),
            eq(dealModel.workspaceId, workspaceId),
            eq(dealModel.status, current.status),
          ),
        )
        .returning()
      if (!updated) {
        throw dealChangedConcurrently()
      }
      await this.recordActivity({
        tx,
        dealId: id,
        type: "statusChanged",
        actorId,
        payload: { from: current.status, to: status },
      })
      const pipeline = await pipelineService.findOrFail({
        workspaceId,
        id: updated.pipelineId,
        tx,
      })
      return {
        changed: true as const,
        deal: updated,
        oldStatus: current.status,
        settings: pipeline.settings,
      }
    })

    if (!outcome.changed) {
      return outcome.deal
    }
    await this.afterStatusChange({
      deal: outcome.deal,
      oldStatus: outcome.oldStatus,
      status,
      settings: outcome.settings,
      actorId,
    })
    return outcome.deal
  }

  /** Audit, company log, `ticketStatusChanged`, then the `won` company stop, AFTER the status committed. */
  private async afterStatusChange(props: {
    deal: DealModel
    oldStatus: DealStatus
    status: DealStatus
    settings: PipelineSettings
    actorId: string | null
  }): Promise<void> {
    const { deal, oldStatus, status, settings, actorId } = props
    await this.audit("deal.status", deal.id)
    await companyActivityService.recordSafely({
      workspaceId: deal.workspaceId,
      companyId: deal.companyId,
      type: "dealStatusChanged",
      actorId,
      payload: {
        dealId: deal.id,
        title: deal.title,
        from: oldStatus,
        to: status,
      },
    })
    await this.emitFor(deal, emitDealStatusChanged, { oldStatus })
    if (
      status === "won" &&
      settings.stopCompanyOn === "won" &&
      deal.companyId
    ) {
      await stopCompanyForDeal({
        workspaceId: deal.workspaceId,
        companyId: deal.companyId,
        dealId: deal.id,
        contactId: deal.contactId,
      })
    }
  }

  async addNote(props: {
    workspaceId: string
    id: string
    text: string
    actorId?: string | null
    viewer?: DealViewer | null
  }): Promise<DealActivityModel> {
    const { workspaceId, id, viewer } = props
    const text = typeof props.text === "string" ? props.text.trim() : ""
    if (text.length === 0) {
      throw validationException("text", "Note text is required.")
    }
    if (text.length > 4000) {
      throw validationException("text", "Note text is at most 4000 characters.")
    }
    await this.findOrFail({ workspaceId, id, viewer })
    return await this.recordActivity({
      tx: db,
      dealId: id,
      type: "note",
      actorId: props.actorId ?? null,
      payload: { text },
    })
  }

  /** With a `viewer` (s193) every id must be readable by them, else 404 and nothing is deleted. */
  async remove(props: {
    workspaceId: string
    ids: string[]
    viewer?: DealViewer | null
    tx?: DatabaseClient
  }): Promise<{ deletedCount: number }> {
    const { workspaceId, ids, viewer, tx = db } = props
    if (ids.length === 0) {
      return { deletedCount: 0 }
    }
    if (viewer) {
      for (const id of ids) {
        await this.findOrFail({ workspaceId, id, viewer, tx })
      }
    }
    const deleted = await tx
      .delete(dealModel)
      .where(
        and(eq(dealModel.workspaceId, workspaceId), inArray(dealModel.id, ids)),
      )
      .returning({ id: dealModel.id })
    if (deleted.length > 0) {
      await this.audit("deal.delete", deleted.map((row) => row.id).join(","))
    }
    return { deletedCount: deleted.length }
  }

  // ---- internals ----------------------------------------------------------

  private async recordActivity(props: {
    tx: DatabaseClient
    dealId: string
    type: DealActivityType
    actorId: string | null
    payload: Record<string, unknown>
  }): Promise<DealActivityModel> {
    const [row] = await props.tx
      .insert(dealActivityModel)
      .values({
        id: createId(),
        dealId: props.dealId,
        type: props.type,
        actorId: props.actorId,
        // jsonb: written explicitly, never by a drizzle default (AGENTS.md)
        payload: props.payload,
      })
      .returning()
    return row
  }

  private async emitFor<Extra extends Record<string, unknown>>(
    deal: DealModel,
    emit: (
      workspaceId: string,
      contactId: string,
      metadata: DealEventMetadata & Extra,
    ) => Promise<void>,
    extra: Extra,
  ): Promise<void> {
    if (!deal.contactId) {
      return
    }
    try {
      await emit(deal.workspaceId, deal.contactId, {
        ...dealEventMetadata(deal),
        ...extra,
      })
    } catch (error) {
      logger.warn({ error, dealId: deal.id }, "deal: event emit failed")
    }
  }

  private async resolveContact(props: {
    workspaceId: string
    contactId: string
    tx: DatabaseClient
  }): Promise<{ id: string; companyId: string | null }> {
    const [contact] = await props.tx
      .select({ id: contactModel.id, companyId: contactModel.companyId })
      .from(contactModel)
      .where(
        and(
          eq(contactModel.id, props.contactId),
          eq(contactModel.workspaceId, props.workspaceId),
        ),
      )
      .limit(1)
    if (!contact) {
      throw notFoundException("Contact not found")
    }
    return contact
  }

  private async resolveCreateOwner(props: {
    workspaceId: string
    ownerId: string | null | undefined
    settings: PipelineSettings
    pipelineId: string
    tx: DatabaseClient
  }): Promise<string | null> {
    const { workspaceId, ownerId, tx } = props
    if (ownerId !== undefined) {
      return await this.resolveOwner({ workspaceId, ownerId, tx })
    }
    if (props.settings.assignOwner !== "roundRobin") {
      return null
    }
    return await pipelineMemberService.pickRoundRobin({
      workspaceId,
      pipelineId: props.pipelineId,
      tx,
    })
  }

  /** An owner must be a member of the workspace; null clears the owner. */
  private resolveOwner(props: {
    workspaceId: string
    ownerId: string | null | undefined
    tx: DatabaseClient
  }): Promise<string | null> {
    return resolveWorkspaceMember({
      workspaceId: props.workspaceId,
      userId: props.ownerId,
      tx: props.tx,
      field: "ownerId",
      role: "Owner",
    })
  }

  private async nextPosition(props: {
    stageId: string
    tx: DatabaseClient
  }): Promise<number> {
    const [{ maxPosition }] = await props.tx
      .select({ maxPosition: sql<number | null>`max(${dealModel.position})` })
      .from(dealModel)
      .where(eq(dealModel.stageId, props.stageId))
    return (Number(maxPosition) || 0) + DEAL_POSITION_STEP
  }

  /** Rewrite positions to `DEAL_POSITION_STEP * i` when any neighbouring gap collapsed. */
  /**
   * Rewrite positions to `DEAL_POSITION_STEP * i` when any neighbouring gap
   * collapsed. Read and write happen in ONE transaction with the rows locked,
   * and the UPDATE is pinned to the stage, so a card that left the stage
   * between read and write is never given a position from its old column.
   */
  private async maybeRenormalize(props: { stageId: string }): Promise<void> {
    await db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: dealModel.id, position: dealModel.position })
        .from(dealModel)
        .where(eq(dealModel.stageId, props.stageId))
        .for("update")
        .orderBy(dealModel.position, dealModel.createdAt)
      let collapsed = false
      for (let i = 1; i < rows.length; i += 1) {
        if (
          Math.abs(rows[i].position - rows[i - 1].position) < MIN_POSITION_GAP
        ) {
          collapsed = true
          break
        }
      }
      if (!collapsed) {
        return
      }
      for (const [index, row] of rows.entries()) {
        await tx
          .update(dealModel)
          .set({ position: (index + 1) * DEAL_POSITION_STEP })
          .where(
            and(eq(dealModel.id, row.id), eq(dealModel.stageId, props.stageId)),
          )
      }
    })
  }

  private parseValue(value: unknown): string | null {
    if (value === undefined || value === null || value === "") {
      return null
    }
    const normalized = normalizeDealValue(value)
    if (normalized === null) {
      throw validationException("value", "Value is a non-negative amount.")
    }
    return normalized
  }

  private parseDueAt(value: unknown): Date | null {
    return parseDateOrNull(value, "dueAt")
  }

  /** `Deal.fields` against the pipeline's fieldDefs; the first issue is the 422. */
  private parseFields(props: {
    defs: readonly DealFieldDef[] | null | undefined
    fields: unknown
    requireAll?: boolean
  }): Record<string, unknown> {
    const issues = validateDealFields(props)
    const first = issues[0]
    if (first) {
      throw validationException(
        first.key === "fields" ? "fields" : `fields.${first.key}`,
        first.key === "fields"
          ? `Fields ${first.message}.`
          : `Field "${first.key}" ${first.message}.`,
        { issues: issues.map((i) => `${i.key}: ${i.message}`).join("; ") },
      )
    }
    return props.fields as Record<string, unknown>
  }

  private parseCurrency(currency: unknown): string {
    const code =
      typeof currency === "string" ? currency.trim().toUpperCase() : ""
    if (!ISO_CURRENCY.test(code)) {
      throw validationException("currency", "Currency is a 3-letter ISO code.")
    }
    return code
  }

  private parsePriority(priority: unknown): DealPriority | null {
    if (priority === undefined || priority === null) {
      return null
    }
    const parsed = dealPriorities.safeParse(priority)
    if (!parsed.success) {
      throw validationException("priority", "Priority is low, medium or high.")
    }
    return parsed.data
  }

  private parseStatus(status: unknown): DealStatus {
    const parsed = dealStatuses.safeParse(status)
    if (!parsed.success) {
      throw validationException("status", "Status is open, won or lost.")
    }
    return parsed.data
  }

  private parsePosition(position: unknown): number {
    if (typeof position !== "number" || !Number.isFinite(position)) {
      throw validationException("position", "Position is a finite number.")
    }
    return position
  }
}

export const dealService = new DealService()
