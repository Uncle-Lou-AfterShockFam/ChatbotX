import {
  and,
  type DatabaseClient,
  db,
  eq,
  inArray,
  type SQL,
  sql,
} from "@chatbotx.io/database/client"
import {
  appointmentCalendarModel,
  appointmentModel,
  companyActivityModel,
  companyNoteModel,
  contactNoteModel,
  dealActivityModel,
  dealModel,
  questionnaireModel,
  questionnaireSubmissionModel,
} from "@chatbotx.io/database/schema"
import { unionAll } from "drizzle-orm/pg-core"
import { type ContactAccessScope, contactService } from "../contact/service"
import { type DealViewer, viewerOwnerFilter } from "../pipeline/access"
import { pipelineService } from "../pipeline/service"
import { companyService } from "./service"

/** One row of a Contact / Company 360 timeline (s195). `payload` is closed per kind. */
export type TimelineKind =
  | "companyActivity"
  | "companyNote"
  | "contactNote"
  | "dealActivity"
  | "submission"
  | "appointment"

export const timelineKinds: readonly TimelineKind[] = [
  "companyActivity",
  "companyNote",
  "contactNote",
  "dealActivity",
  "submission",
  "appointment",
]

export type TimelineRow = {
  kind: TimelineKind
  id: string
  at: Date
  payload: Record<string, unknown>
}

export type TimelinePage = { data: TimelineRow[]; nextCursor: string | null }

export const MAX_TIMELINE_PAGE = 100
/** `<epochMs>:<id>` of the last row returned; malformed = first page. */
const CURSOR = /^(\d{1,16}):(\d{1,30})$/

// biome-ignore lint/suspicious/noExplicitAny: five differently-typed selects meet in one UNION ALL
type TimelineSelect = any
/** The branch's own `(createdAt, id)` columns -> the keyset predicate for this page, or undefined on page one. */
type CursorFor = (
  at: SQL | { getSQL(): SQL },
  id: SQL | { getSQL(): SQL },
) => SQL | undefined
type Branch = {
  kind: TimelineKind
  build: (cursor: CursorFor) => TimelineSelect
}

function parseLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? 30), 1), MAX_TIMELINE_PAGE)
}

function parseKinds(
  kinds: readonly string[] | null | undefined,
): Set<TimelineKind> {
  if (!kinds || kinds.length === 0) {
    return new Set(timelineKinds)
  }
  const out = new Set<TimelineKind>()
  for (const kind of kinds) {
    if ((timelineKinds as readonly string[]).includes(kind)) {
      out.add(kind as TimelineKind)
    }
  }
  return out
}

/**
 * `(at, id) < (anchorAt, anchorId)` built from the BRANCH'S OWN columns: a
 * bare `"createdAt"` would be ambiguous in the branches that join a second
 * table (deal activity + deal, submission + questionnaire, appointment +
 * calendar). A malformed cursor = first page (no predicate).
 */
function cursorFor(cursor: string | null | undefined): CursorFor {
  const parsed = cursor ? CURSOR.exec(cursor) : null
  if (!parsed) {
    return () => undefined
  }
  const [, ms, anchorId] = parsed
  const anchor = new Date(Number(ms))
  return (at, id) => sql`(${at}, ${id}) < (${anchor}, ${anchorId}::bigint)`
}

/**
 * Contact / Company 360 timelines (s195). One `UNION ALL` over the MAIN
 * database only: company change log, company / contact notes, the activity of
 * the deals the viewer may see, questionnaire submissions and appointments of
 * the contacts in scope. Messages live on the sharded message store and are
 * NOT here: the pages show them as their own tab. Keyset paged on `(at, id)`.
 */
class CrmTimelineService {
  async forCompany(props: {
    workspaceId: string
    companyId: string
    kinds?: readonly string[] | null
    cursor?: string | null
    limit?: number
    viewer?: DealViewer | null
    /** the caller's assigned-only contact scope: submissions / appointments of other reps' contacts stay out */
    accessScope?: ContactAccessScope
    tx?: DatabaseClient
  }): Promise<TimelinePage> {
    const { workspaceId, companyId, cursor, viewer, tx = db } = props
    await companyService.findOrFail({ workspaceId, id: companyId, tx })
    const contactIds = await companyService.listContactIds({
      workspaceId,
      companyId,
      accessScope: props.accessScope,
      tx,
    })
    const dealScope = and(
      eq(dealModel.workspaceId, workspaceId),
      eq(dealModel.companyId, companyId),
    )
    const branches: Branch[] = [
      {
        kind: "companyActivity",
        build: (c) =>
          tx
            .select({
              kind: sql<string>`'companyActivity'`.as("kind"),
              id: companyActivityModel.id,
              at: companyActivityModel.createdAt,
              payload: sql<Record<string, unknown>>`jsonb_build_object(
                'type', ${companyActivityModel.type},
                'actorId', ${companyActivityModel.actorId},
                'data', ${companyActivityModel.payload}
              )`.as("payload"),
            })
            .from(companyActivityModel)
            .where(
              and(
                eq(companyActivityModel.workspaceId, workspaceId),
                eq(companyActivityModel.companyId, companyId),
                c(companyActivityModel.createdAt, companyActivityModel.id),
              ),
            ),
      },
      {
        kind: "companyNote",
        build: (c) =>
          tx
            .select({
              kind: sql<string>`'companyNote'`.as("kind"),
              id: companyNoteModel.id,
              at: companyNoteModel.createdAt,
              payload: sql<Record<string, unknown>>`jsonb_build_object(
                'text', ${companyNoteModel.text},
                'createdById', ${companyNoteModel.createdById}
              )`.as("payload"),
            })
            .from(companyNoteModel)
            .where(
              and(
                eq(companyNoteModel.workspaceId, workspaceId),
                eq(companyNoteModel.companyId, companyId),
                c(companyNoteModel.createdAt, companyNoteModel.id),
              ),
            ),
      },
    ]
    return await this.run({
      tx,
      workspaceId,
      branches,
      contactIds,
      dealScope,
      kinds: parseKinds(props.kinds),
      cursor,
      limit: parseLimit(props.limit),
      viewer,
    })
  }

  /** The contact, in the workspace AND inside the caller's assigned-only scope (404 otherwise). */
  async assertContact(props: {
    workspaceId: string
    contactId: string
    accessScope?: ContactAccessScope
    tx?: DatabaseClient
  }): Promise<void> {
    await contactService.findByIdOrFail({
      workspaceId: props.workspaceId,
      id: props.contactId,
      accessScope: props.accessScope,
      tx: props.tx,
    })
  }

  async forContact(props: {
    workspaceId: string
    contactId: string
    kinds?: readonly string[] | null
    cursor?: string | null
    limit?: number
    viewer?: DealViewer | null
    accessScope?: ContactAccessScope
    tx?: DatabaseClient
  }): Promise<TimelinePage> {
    const { workspaceId, contactId, cursor, viewer, tx = db } = props
    await this.assertContact({
      workspaceId,
      contactId,
      accessScope: props.accessScope,
      tx,
    })
    const dealScope = and(
      eq(dealModel.workspaceId, workspaceId),
      eq(dealModel.contactId, contactId),
    )
    const branches: Branch[] = [
      {
        kind: "contactNote",
        build: (c) =>
          tx
            .select({
              kind: sql<string>`'contactNote'`.as("kind"),
              id: contactNoteModel.id,
              at: contactNoteModel.createdAt,
              payload: sql<Record<string, unknown>>`jsonb_build_object(
                'text', ${contactNoteModel.text},
                'createdById', ${contactNoteModel.createdById}
              )`.as("payload"),
            })
            .from(contactNoteModel)
            .where(
              and(
                eq(contactNoteModel.contactId, contactId),
                c(contactNoteModel.createdAt, contactNoteModel.id),
              ),
            ),
      },
    ]
    return await this.run({
      tx,
      workspaceId,
      branches,
      contactIds: [contactId],
      dealScope,
      kinds: parseKinds(props.kinds),
      cursor,
      limit: parseLimit(props.limit),
      viewer,
    })
  }

  private async run(props: {
    tx: DatabaseClient
    workspaceId: string
    branches: Branch[]
    contactIds: string[]
    dealScope: SQL | undefined
    kinds: Set<TimelineKind>
    cursor: string | null | undefined
    limit: number
    viewer: DealViewer | null | undefined
  }): Promise<TimelinePage> {
    const { tx, workspaceId, contactIds, dealScope, kinds, cursor, limit } =
      props
    const visible = await pipelineService.visibleIds({
      workspaceId,
      viewer: props.viewer,
      tx,
    })
    const ownerFilter = props.viewer
      ? viewerOwnerFilter(props.viewer)
      : undefined
    let dealVisible: SQL | undefined
    if (visible !== null) {
      dealVisible =
        visible.length === 0
          ? sql`false`
          : inArray(dealModel.pipelineId, visible)
    }
    const branches: Branch[] = [
      ...props.branches,
      {
        kind: "dealActivity",
        build: (c) =>
          tx
            .select({
              kind: sql<string>`'dealActivity'`.as("kind"),
              id: dealActivityModel.id,
              at: dealActivityModel.createdAt,
              payload: sql<Record<string, unknown>>`jsonb_build_object(
                'dealId', ${dealModel.id},
                'dealTitle', ${dealModel.title},
                'pipelineId', ${dealModel.pipelineId},
                'type', ${dealActivityModel.type},
                'actorId', ${dealActivityModel.actorId},
                'data', ${dealActivityModel.payload}
              )`.as("payload"),
            })
            .from(dealActivityModel)
            .innerJoin(dealModel, eq(dealActivityModel.dealId, dealModel.id))
            .where(
              and(
                dealScope,
                dealVisible,
                ownerFilter === undefined
                  ? undefined
                  : eq(dealModel.ownerId, ownerFilter),
                c(dealActivityModel.createdAt, dealActivityModel.id),
              ),
            ),
      },
      {
        kind: "submission",
        build: (c) =>
          tx
            .select({
              kind: sql<string>`'submission'`.as("kind"),
              id: questionnaireSubmissionModel.id,
              at: questionnaireSubmissionModel.createdAt,
              payload: sql<Record<string, unknown>>`jsonb_build_object(
                'questionnaireId', ${questionnaireSubmissionModel.questionnaireId},
                'questionnaireName', ${questionnaireModel.name},
                'contactId', ${questionnaireSubmissionModel.contactId},
                'status', ${questionnaireSubmissionModel.status},
                'totalPoints', ${questionnaireSubmissionModel.totalPoints},
                'completedAt', ${questionnaireSubmissionModel.completedAt}
              )`.as("payload"),
            })
            .from(questionnaireSubmissionModel)
            .innerJoin(
              questionnaireModel,
              eq(
                questionnaireSubmissionModel.questionnaireId,
                questionnaireModel.id,
              ),
            )
            .where(
              and(
                eq(questionnaireSubmissionModel.workspaceId, workspaceId),
                contactIds.length === 0
                  ? sql`false`
                  : inArray(questionnaireSubmissionModel.contactId, contactIds),
                c(
                  questionnaireSubmissionModel.createdAt,
                  questionnaireSubmissionModel.id,
                ),
              ),
            ),
      },
      {
        kind: "appointment",
        build: (c) =>
          tx
            .select({
              kind: sql<string>`'appointment'`.as("kind"),
              id: appointmentModel.id,
              at: appointmentModel.createdAt,
              payload: sql<Record<string, unknown>>`jsonb_build_object(
                'calendarId', ${appointmentModel.calendarId},
                'calendarName', ${appointmentCalendarModel.name},
                'contactId', ${appointmentModel.contactId},
                'status', ${appointmentModel.status},
                'startAt', ${appointmentModel.startAt},
                'endAt', ${appointmentModel.endAt}
              )`.as("payload"),
            })
            .from(appointmentModel)
            .innerJoin(
              appointmentCalendarModel,
              eq(appointmentModel.calendarId, appointmentCalendarModel.id),
            )
            .where(
              and(
                eq(appointmentModel.workspaceId, workspaceId),
                contactIds.length === 0
                  ? sql`false`
                  : inArray(appointmentModel.contactId, contactIds),
                c(appointmentModel.createdAt, appointmentModel.id),
              ),
            ),
      },
    ]
    const selected = branches.filter((b) => kinds.has(b.kind))
    if (selected.length === 0) {
      return { data: [], nextCursor: null }
    }
    const c = cursorFor(cursor)
    const queries = selected.map((b) => b.build(c))
    const [first, ...rest] = queries
    const union: TimelineSelect =
      rest.length === 0
        ? first
        : (unionAll as (...q: TimelineSelect[]) => TimelineSelect)(
            first,
            ...rest,
          )
    const rows = (await union
      .orderBy(sql`"at" desc, "id" desc`)
      .limit(limit + 1)) as TimelineRow[]
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return {
      data: page,
      nextCursor:
        rows.length > limit && last
          ? `${new Date(last.at).getTime()}:${last.id}`
          : null,
    }
  }
}

export const crmTimelineService = new CrmTimelineService()
