import {
  and,
  type DatabaseClient,
  db,
  desc,
  eq,
  exists,
  findOrFail,
  inArray,
  isNull,
  relationsFilterToSQL,
  type SQL,
  sql,
} from "@chatbotx.io/database/client"
import {
  DEFAULT_COMPANY_STOP_TAG_NAME,
  extractEmailDomain,
  isFreeMailDomain,
  normalizeCompanyDomains,
} from "@chatbotx.io/database/partials"
import {
  companyModel,
  contactModel,
  conversationModel,
} from "@chatbotx.io/database/schema"
import type { CompanyModel } from "@chatbotx.io/database/types"
import {
  likeContains,
  parseOrderByAsObject,
  parsePagination,
} from "@chatbotx.io/database/utils"
import { createId } from "@chatbotx.io/utils"
import { BaseService } from "../base.service"
import { type ContactAccessScope, contactService } from "../contact/service"
import {
  ChatbotXException,
  notFoundException,
  validationException,
} from "../errors"
import type { PaginatedResult } from "../types"
import { workspaceService } from "../workspace/service"
import { companyActivityService } from "./activity"

export type ListCompaniesInput = {
  workspaceId: string
  name?: string | null
  domain?: string | null
  stopped?: boolean | null
  page?: number | null
  perPage?: number | null
  sort?: { id: string; desc: boolean }[] | null
}

export type CompanyData = {
  name: string
  domains?: string[] | null
  website?: string | null
  phone?: string | null
  notes?: string | null
  stopOnReply?: boolean | null
}

export type CompanyWithContactCount = CompanyModel & { contactCount: number }

const COMPANY_NOT_FOUND = "Company not found"

/** 409-class: the contact's company moved under us; the caller reloads and retries. */
const companyChangedConcurrently = () =>
  validationException(
    "companyId",
    "The contact's company was changed by someone else; reload and retry.",
    { conflict: "stale" },
  )

/**
 * The assigned-only rule for a raw contact select (s195): the same
 * `conversation.assignedUserId` predicate `withContactAccessScope` applies to
 * relational reads, so a company rollup never lists a contact the caller
 * could not open. Undefined = unrestricted.
 */
function contactScopeSQL(accessScope?: ContactAccessScope): SQL | undefined {
  const userId = accessScope?.restrictToAssignedUserId
  if (!userId) {
    return
  }
  return exists(
    db
      .select({ one: sql`1` })
      .from(conversationModel)
      .where(
        and(
          eq(conversationModel.contactId, contactModel.id),
          eq(conversationModel.assignedUserId, userId),
        ),
      ),
  )
}

/**
 * Companies group contacts (`Contact.companyId`). This service is edge-safe
 * (barrel-exported); the stop cascade lives in `./stop.ts` behind the
 * `@chatbotx.io/business/company-stop` subpath because it reaches
 * `contact-sequence`, which is Node-only.
 */
class CompanyService extends BaseService {
  async findOrFail(props: {
    workspaceId: string
    id: string
    tx?: DatabaseClient
  }): Promise<CompanyModel> {
    const { workspaceId, id, tx = db } = props
    return await findOrFail({
      client: tx,
      table: companyModel,
      where: { id, workspaceId },
      message: COMPANY_NOT_FOUND,
    })
  }

  async list(
    input: ListCompaniesInput,
  ): Promise<PaginatedResult<CompanyWithContactCount>> {
    const where = {
      workspaceId: input.workspaceId,
      name: input.name ? { ilike: likeContains(input.name) } : undefined,
      stoppedAt:
        input.stopped === true
          ? { isNotNull: true as const }
          : // biome-ignore lint/style/noNestedTernary: three-way filter
            input.stopped === false
            ? { isNull: true as const }
            : undefined,
      domains: input.domain
        ? { arrayContains: [input.domain.trim().toLowerCase()] }
        : undefined,
    }

    const requestedOrderBy = parseOrderByAsObject(companyModel, input)
    const orderBy =
      Object.keys(requestedOrderBy).length > 0
        ? requestedOrderBy
        : { createdAt: "desc" as const }
    const pagination = parsePagination(input)

    const [rows, total] = await Promise.all([
      db.query.companyModel.findMany({ where, orderBy, ...pagination }),
      db.$count(companyModel, relationsFilterToSQL(companyModel, where)),
    ])

    const counts = await this.countContacts({
      workspaceId: input.workspaceId,
      companyIds: rows.map((row) => row.id),
    })
    const data = rows.map((row) => ({
      ...row,
      contactCount: counts.get(row.id) ?? 0,
    }))

    const pageCount = pagination?.limit
      ? Math.ceil(total / pagination.limit)
      : 1

    return { data, pageCount }
  }

  async countContacts(props: {
    workspaceId: string
    companyIds: string[]
    accessScope?: ContactAccessScope
    tx?: DatabaseClient
  }): Promise<Map<string, number>> {
    const { workspaceId, companyIds, tx = db } = props
    const counts = new Map<string, number>()
    if (companyIds.length === 0) {
      return counts
    }
    const rows = await tx
      .select({
        companyId: contactModel.companyId,
        total: sql<number>`count(*)::int`,
      })
      .from(contactModel)
      .where(
        and(
          eq(contactModel.workspaceId, workspaceId),
          inArray(contactModel.companyId, companyIds),
          contactScopeSQL(props.accessScope),
        ),
      )
      .groupBy(contactModel.companyId)
    for (const row of rows) {
      if (row.companyId) {
        counts.set(row.companyId, Number(row.total))
      }
    }
    return counts
  }

  async create(props: {
    workspaceId: string
    data: CompanyData
    actorId?: string | null
    tx?: DatabaseClient
  }): Promise<CompanyModel> {
    const { workspaceId, data, tx = db } = props
    const actorId = props.actorId ?? null
    const name = data.name.trim()
    if (name.length === 0) {
      throw validationException("name", "Name is required.")
    }
    const domains = this.parseDomains(data.domains)

    const existing = await tx.query.companyModel.findFirst({
      columns: { id: true },
      where: { name, workspaceId },
    })
    if (existing) {
      throw new ChatbotXException("Name is already taken.", "nameTaken", 400)
    }

    const [company] = await tx
      .insert(companyModel)
      .values({
        id: createId(),
        workspaceId,
        name,
        domains,
        website: data.website ?? null,
        phone: data.phone ?? null,
        notes: data.notes ?? null,
        stopOnReply: data.stopOnReply ?? true,
      })
      .returning()

    await companyActivityService.record({
      tx,
      workspaceId,
      companyId: company.id,
      type: "created",
      actorId,
      payload: { name },
    })
    await this.audit("company.create", company.id)
    return company
  }

  async update(props: {
    workspaceId: string
    id: string
    data: Partial<CompanyData>
    actorId?: string | null
    tx?: DatabaseClient
  }): Promise<CompanyModel> {
    const { workspaceId, id, data, tx = db } = props
    const actorId = props.actorId ?? null

    const current = await this.findOrFail({ workspaceId, id, tx })

    const set: Partial<typeof companyModel.$inferInsert> = {}
    if (data.name !== undefined) {
      const name = data.name.trim()
      if (name.length === 0) {
        throw validationException("name", "Name is required.")
      }
      const taken = await tx.query.companyModel.findFirst({
        columns: { id: true },
        where: { name, workspaceId, id: { ne: id } },
      })
      if (taken) {
        throw new ChatbotXException("Name is already taken.", "nameTaken", 400)
      }
      set.name = name
    }
    if (data.domains !== undefined) {
      set.domains = this.parseDomains(data.domains)
    }
    if (data.website !== undefined) {
      set.website = data.website
    }
    if (data.phone !== undefined) {
      set.phone = data.phone
    }
    if (data.notes !== undefined) {
      set.notes = data.notes
    }
    if (data.stopOnReply !== undefined && data.stopOnReply !== null) {
      set.stopOnReply = data.stopOnReply
    }

    if (Object.keys(set).length === 0) {
      return await this.findOrFail({ workspaceId, id, tx })
    }

    const [updated] = await tx
      .update(companyModel)
      .set(set)
      .where(
        and(eq(companyModel.id, id), eq(companyModel.workspaceId, workspaceId)),
      )
      .returning()

    if (!updated) {
      throw notFoundException(COMPANY_NOT_FOUND)
    }
    const changed: Record<string, { from: unknown; to: unknown }> = {}
    for (const key of Object.keys(set) as (keyof typeof set)[]) {
      const before = current[key as keyof CompanyModel] ?? null
      const after = updated[key as keyof CompanyModel] ?? null
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changed[key] = { from: before, to: after }
      }
    }
    if (Object.keys(changed).length > 0) {
      await companyActivityService.record({
        tx,
        workspaceId,
        companyId: id,
        type: "updated",
        actorId,
        payload: { changed },
      })
    }
    await this.audit("company.update", id)
    return updated
  }

  /** Contacts keep their rows; the FK sets `companyId` to null. */
  async delete(props: {
    workspaceId: string
    ids: string[]
    tx?: DatabaseClient
  }): Promise<{ deletedCount: number }> {
    const { workspaceId, ids, tx = db } = props
    if (ids.length === 0) {
      return { deletedCount: 0 }
    }

    const deleted = await tx
      .delete(companyModel)
      .where(
        and(
          eq(companyModel.workspaceId, workspaceId),
          inArray(companyModel.id, ids),
        ),
      )
      .returning({ id: companyModel.id })

    if (deleted.length > 0) {
      await contactService.invalidate({ workspaceId })
      await this.audit("company.delete", deleted.map((row) => row.id).join(","))
    }
    return { deletedCount: deleted.length }
  }

  /** The company owning a domain, or undefined; free-mail domains never match. */
  async findByDomain(props: {
    workspaceId: string
    domain: string
    tx?: DatabaseClient
  }): Promise<{ id: string } | undefined> {
    const { workspaceId, tx = db } = props
    const domain = props.domain.trim().toLowerCase()
    if (domain.length === 0 || isFreeMailDomain(domain)) {
      return
    }
    const [row] = await tx
      .select({ id: companyModel.id })
      .from(companyModel)
      .where(
        and(
          eq(companyModel.workspaceId, workspaceId),
          sql`${domain} = ANY(${companyModel.domains})`,
        ),
      )
      .limit(1)
    return row
  }

  /**
   * Set (or clear, `companyId: null`) a contact's company. The old company
   * logs `contactUnlinked`, the new one `contactLinked` (s195); a no-op
   * assignment logs nothing. The UPDATE is pinned to the company this call
   * READ (and to `expectedCompanyId` when the caller names one, e.g. the
   * company page's unlink): a concurrent re-link makes it touch 0 rows and
   * the call is a 409, never a silent detach from a company nobody saw.
   */
  async assignContact(props: {
    workspaceId: string
    contactId: string
    companyId: string | null
    expectedCompanyId?: string | null
    actorId?: string | null
    tx?: DatabaseClient
  }): Promise<void> {
    const { workspaceId, contactId, companyId, tx = db } = props
    const actorId = props.actorId ?? null
    if (companyId !== null) {
      await this.findOrFail({ workspaceId, id: companyId, tx })
    }
    const [before] = await tx
      .select({ id: contactModel.id, companyId: contactModel.companyId })
      .from(contactModel)
      .where(
        and(
          eq(contactModel.id, contactId),
          eq(contactModel.workspaceId, workspaceId),
        ),
      )
      .limit(1)
    if (!before) {
      throw notFoundException("Contact not found")
    }
    if (
      props.expectedCompanyId !== undefined &&
      before.companyId !== props.expectedCompanyId
    ) {
      throw companyChangedConcurrently()
    }
    if (before.companyId === companyId) {
      return
    }
    const updated = await tx
      .update(contactModel)
      .set({ companyId })
      .where(
        and(
          eq(contactModel.id, contactId),
          eq(contactModel.workspaceId, workspaceId),
          before.companyId === null
            ? isNull(contactModel.companyId)
            : eq(contactModel.companyId, before.companyId),
        ),
      )
      .returning({ id: contactModel.id })
    if (updated.length === 0) {
      throw companyChangedConcurrently()
    }
    if (before.companyId) {
      await companyActivityService.record({
        tx,
        workspaceId,
        companyId: before.companyId,
        type: "contactUnlinked",
        actorId,
        payload: { contactId, toCompanyId: companyId },
      })
    }
    if (companyId) {
      await companyActivityService.record({
        tx,
        workspaceId,
        companyId,
        type: "contactLinked",
        actorId,
        payload: { contactId, fromCompanyId: before.companyId },
      })
    }
    await contactService.invalidate({ workspaceId, ids: [contactId] })
  }

  /**
   * Link a contact to the company that owns its email domain. No-op when the
   * contact already has a company, the address is not an email, the domain is
   * free-mail, or no company claims it. The `companyId IS NULL` predicate lets
   * a concurrent manual assignment win.
   */
  async autoLinkContact(props: {
    workspaceId: string
    contactId: string
    email: string | null | undefined
    tx?: DatabaseClient
  }): Promise<{ linked: boolean; companyId?: string }> {
    const { workspaceId, contactId, tx = db } = props
    const domain = extractEmailDomain(props.email)
    if (!domain || isFreeMailDomain(domain)) {
      return { linked: false }
    }
    const company = await this.findByDomain({ workspaceId, domain, tx })
    if (!company) {
      return { linked: false }
    }
    const updated = await tx
      .update(contactModel)
      .set({ companyId: company.id })
      .where(
        and(
          eq(contactModel.id, contactId),
          eq(contactModel.workspaceId, workspaceId),
          isNull(contactModel.companyId),
        ),
      )
      .returning({ id: contactModel.id })
    if (updated.length === 0) {
      return { linked: false }
    }
    await contactService.invalidate({ workspaceId, ids: [contactId] })
    return { linked: true, companyId: company.id }
  }

  /** Contact ids on the company, inside the caller's assigned-only scope when one is given. */
  async listContactIds(props: {
    workspaceId: string
    companyId: string
    accessScope?: ContactAccessScope
    tx?: DatabaseClient
  }): Promise<string[]> {
    const { workspaceId, companyId, tx = db } = props
    const rows = await tx
      .select({ id: contactModel.id })
      .from(contactModel)
      .where(
        and(
          eq(contactModel.workspaceId, workspaceId),
          eq(contactModel.companyId, companyId),
          contactScopeSQL(props.accessScope),
        ),
      )
    return rows.map((row) => row.id)
  }

  /** The company's contacts, newest first, for the company page. */
  async listContacts(props: {
    workspaceId: string
    companyId: string
    limit?: number
    accessScope?: ContactAccessScope
    tx?: DatabaseClient
  }): Promise<
    Pick<
      typeof contactModel.$inferSelect,
      | "id"
      | "firstName"
      | "lastName"
      | "fullName"
      | "email"
      | "phoneNumber"
      | "avatar"
      | "createdAt"
    >[]
  > {
    const { workspaceId, companyId, limit = 200, tx = db } = props
    return await tx
      .select({
        id: contactModel.id,
        firstName: contactModel.firstName,
        lastName: contactModel.lastName,
        fullName: contactModel.fullName,
        email: contactModel.email,
        phoneNumber: contactModel.phoneNumber,
        avatar: contactModel.avatar,
        createdAt: contactModel.createdAt,
      })
      .from(contactModel)
      .where(
        and(
          eq(contactModel.workspaceId, workspaceId),
          eq(contactModel.companyId, companyId),
          contactScopeSQL(props.accessScope),
        ),
      )
      .orderBy(desc(contactModel.createdAt))
      .limit(limit)
  }

  async countForWorkspace(props: {
    workspaceId: string
    tx?: DatabaseClient
  }): Promise<number> {
    const { workspaceId, tx = db } = props
    return await tx.$count(
      companyModel,
      eq(companyModel.workspaceId, workspaceId),
    )
  }

  /** The tag name that stops a company when applied to one of its contacts. */
  async resolveStopTagName(props: { workspaceId: string }): Promise<string> {
    const workspace = await workspaceService.find({
      where: { id: props.workspaceId },
    })
    const configured = workspace?.companyStopTagName?.trim()
    return configured && configured.length > 0
      ? configured
      : DEFAULT_COMPANY_STOP_TAG_NAME
  }

  private parseDomains(domains: string[] | null | undefined): string[] {
    const normalized = normalizeCompanyDomains(domains ?? [])
    const free = normalized.find((domain) => isFreeMailDomain(domain))
    if (free) {
      throw validationException(
        "domains",
        `${free} is a consumer mailbox domain and cannot identify a company.`,
        { domain: free },
      )
    }
    return normalized
  }
}

export const companyService = new CompanyService()
