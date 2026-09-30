import {
  and,
  type DatabaseClient,
  db,
  desc,
  eq,
  isUniqueViolationError,
  lt,
  sql,
} from "@chatbotx.io/database/client"
import {
  PAGE_LINK_RETAIN_DAYS,
  PAGE_LINK_TTL_DEFAULT_HOURS,
  PAGE_LINK_TTL_MAX_HOURS,
  PAGE_LINK_TTL_MIN_HOURS,
  PAGE_MAX_NAME,
  type PageStatus,
} from "@chatbotx.io/database/partials"
import {
  contactModel,
  pageLinkModel,
  pageModel,
} from "@chatbotx.io/database/schema"
import type { PageLinkModel, PageModel } from "@chatbotx.io/database/types"
import {
  collectRenderInputs,
  type EmailDocument,
  leafBlocks,
  parseDocument,
  type RenderAsset,
} from "@chatbotx.io/email-document"
import { renderWeb } from "@chatbotx.io/email-document/render-web"
import { createId, isBase62Token, mintBase62Token } from "@chatbotx.io/utils"
import { BaseService } from "../base.service"
import type { ResolveDocumentVariables } from "../documents/service"
import { documentFlowButton } from "../email-templates/buttons"
import {
  assertAssetsOwned,
  type DocumentIssue,
  parseNamedDocument,
  parsePreviewDocument,
  resolveOwnedAssets,
} from "../email-templates/document-data"
import { signEmailFlowToken } from "../email-topic/flow-url"
import { notFoundException, validationException } from "../errors"
import { pageHtml } from "./html"

const PAGE_NOT_FOUND = "Page not found"
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
/** Base62, 22 characters = 128 random bits (same as /f and /pay). */
export const PAGE_TOKEN_LENGTH = 22
/** Links deleted per sweep statement (bounded work per schedule tick). */
const SWEEP_BATCH = 1000
/** A caller-chosen idempotency key per page (a flow run's execution + step). */
export const PAGE_LINK_REF_REGEX = /^[A-Za-z0-9._:-]{1,200}$/

export const isPageToken = (value: unknown): value is string =>
  isBase62Token(value, PAGE_TOKEN_LENGTH)

export const mintPageToken = (random?: (bytes: number) => Uint8Array): string =>
  mintBase62Token(16, PAGE_TOKEN_LENGTH, random)

export type PageData = {
  name: unknown
  document: unknown
  linkTtlHours?: unknown
}

export type PagePreview =
  | {
      ok: true
      html: string
      missing: string[]
      assets: Record<string, RenderAsset>
    }
  | { ok: false; issues: DocumentIssue[] }

/** Why a `/p/<token>` visit renders nothing (the route maps it to 404/410). */
export type PageViewRefusal = "invalid" | "not-found" | "expired" | "archived"

export type PageView =
  | { ok: true; link: PageLinkModel; page: PageModel }
  | { ok: false; reason: PageViewRefusal }

function parseTtl(value: unknown): number {
  if (value === undefined || value === null) {
    return PAGE_LINK_TTL_DEFAULT_HOURS
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < PAGE_LINK_TTL_MIN_HOURS ||
    value > PAGE_LINK_TTL_MAX_HOURS
  ) {
    throw validationException(
      "linkTtlHours",
      `The link lifetime must be ${PAGE_LINK_TTL_MIN_HOURS}-${PAGE_LINK_TTL_MAX_HOURS} whole hours`,
    )
  }
  return value
}

/** The only write path for a page: name + document (shared rules) + TTL. */
function parsePageData(data: PageData) {
  const parsed = parseNamedDocument(data, PAGE_MAX_NAME, "page document")
  return { ...parsed, linkTtlHours: parseTtl(data.linkTtlHours) }
}

function nameTaken(error: unknown): never {
  if (isUniqueViolationError(error)) {
    throw validationException("name", "A page with this name exists")
  }
  throw error
}

/**
 * Button URLs for one render. A flow button (start a flow / node) becomes a
 * sealed /email-topic/flow confirm link for THIS contact + contact inbox:
 * the confirm POST starts it, a scanner's GET never does. An openWebsite
 * button is its URL (the renderer drops a non-http(s) one). Anything else,
 * or a link without a contact inbox, renders no button.
 */
async function buttonUrls(props: {
  document: EmailDocument
  appUrl: string
  link: Pick<PageLinkModel, "workspaceId" | "contactId" | "contactInboxId">
}): Promise<Map<string, string>> {
  const { link } = props
  const urls = new Map<string, string>()
  for (const leaf of leafBlocks(props.document)) {
    if (leaf.type !== "button") {
      continue
    }
    const button = documentFlowButton(leaf)
    if (!button) {
      continue
    }
    if (button.buttonType === "openWebsite") {
      urls.set(leaf.id, button.beforeStep.url)
      continue
    }
    if (
      (button.buttonType !== "startExternalFlow" &&
        button.buttonType !== "startExternalNode") ||
      !link.contactInboxId
    ) {
      continue
    }
    const sealed = await signEmailFlowToken({
      workspaceId: link.workspaceId,
      flowId: button.beforeStep.flowId,
      ...(button.buttonType === "startExternalNode"
        ? { nodeId: button.beforeStep.nodeId }
        : {}),
      contactId: link.contactId,
      contactInboxId: link.contactInboxId,
    })
    urls.set(
      leaf.id,
      `${props.appUrl}/email-topic/flow?${new URLSearchParams({ t: sealed })}`,
    )
  }
  return urls
}

export class PageService extends BaseService {
  async list(props: {
    workspaceId: string
    includeArchived?: boolean
    tx?: DatabaseClient
  }): Promise<PageModel[]> {
    const { workspaceId, includeArchived = false, tx = db } = props
    return await tx
      .select()
      .from(pageModel)
      .where(
        includeArchived
          ? eq(pageModel.workspaceId, workspaceId)
          : and(
              eq(pageModel.workspaceId, workspaceId),
              eq(pageModel.status, "active"),
            ),
      )
      .orderBy(desc(pageModel.updatedAt), desc(pageModel.id))
  }

  async get(props: {
    workspaceId: string
    id: string
    tx?: DatabaseClient
  }): Promise<PageModel> {
    const { workspaceId, id, tx = db } = props
    const [row] = await tx
      .select()
      .from(pageModel)
      .where(and(eq(pageModel.id, id), eq(pageModel.workspaceId, workspaceId)))
      .limit(1)
    if (!row) {
      throw notFoundException(PAGE_NOT_FOUND)
    }
    return row
  }

  async create(props: {
    workspaceId: string
    userId?: string | null
    data: PageData
    tx?: DatabaseClient
  }): Promise<PageModel> {
    const { workspaceId, userId = null, tx = db } = props
    const data = parsePageData(props.data)
    await assertAssetsOwned(workspaceId, data.document, tx)
    const [row] = await tx
      .insert(pageModel)
      .values({
        id: createId(),
        workspaceId,
        createdById: userId,
        status: "active",
        ...data,
      })
      .returning()
      .catch(nameTaken)
    await this.audit("create", `created a page (#${row.id})`)
    return row
  }

  async update(props: {
    workspaceId: string
    id: string
    data: PageData
    tx?: DatabaseClient
  }): Promise<PageModel> {
    const { workspaceId, id, tx = db } = props
    const data = parsePageData(props.data)
    await assertAssetsOwned(workspaceId, data.document, tx)
    const [row] = await tx
      .update(pageModel)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(pageModel.id, id), eq(pageModel.workspaceId, workspaceId)))
      .returning()
      .catch(nameTaken)
    if (!row) {
      throw notFoundException(PAGE_NOT_FOUND)
    }
    await this.audit("update", `updated a page (#${row.id})`)
    return row
  }

  /** Archiving closes every link to the page (410); restoring reopens them. */
  async setStatus(props: {
    workspaceId: string
    id: string
    status: PageStatus
    tx?: DatabaseClient
  }): Promise<PageModel> {
    const { workspaceId, id, status, tx = db } = props
    const [row] = await tx
      .update(pageModel)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(pageModel.id, id), eq(pageModel.workspaceId, workspaceId)))
      .returning()
    if (!row) {
      throw notFoundException(PAGE_NOT_FOUND)
    }
    await this.audit(
      "update",
      `${status === "archived" ? "archived" : "restored"} a page (#${row.id})`,
    )
    return row
  }

  /** Deletes the page and (FK cascade) every link to it: they turn 404. */
  async delete(props: {
    workspaceId: string
    id: string
    tx?: DatabaseClient
  }): Promise<void> {
    const { workspaceId, id, tx = db } = props
    const deleted = await tx
      .delete(pageModel)
      .where(and(eq(pageModel.id, id), eq(pageModel.workspaceId, workspaceId)))
      .returning({ id: pageModel.id })
    if (deleted.length === 0) {
      throw notFoundException(PAGE_NOT_FOUND)
    }
    await this.audit("delete", `deleted a page (#${id})`)
  }

  /**
   * The operator preview: the draft rendered as the public page (renderWeb,
   * full HTML document) with sample merge values and no buttons signed.
   * A schema miss comes back as issues, never an error.
   */
  async preview(props: {
    workspaceId: string
    document: unknown
    vars?: Record<string, string>
    tx?: DatabaseClient
  }): Promise<PagePreview> {
    const { workspaceId, tx = db } = props
    const parsed = parsePreviewDocument(props.document, "page document")
    if (!parsed.ok) {
      return parsed
    }
    const { document } = parsed
    const assets = await resolveOwnedAssets(workspaceId, document, tx)
    const rendered = renderWeb(document, { vars: props.vars ?? {}, assets })
    return {
      ok: true,
      html: pageHtml({ title: "Preview", document, body: rendered.html }),
      missing: rendered.missing,
      assets,
    }
  }

  /**
   * One contact's link to an ACTIVE page of the same workspace. With a
   * `ref`, the call is idempotent per page: a retry (same flow execution +
   * step) returns the row the first call created, whatever its expiry.
   */
  async mintLink(props: {
    workspaceId: string
    pageId: string
    contactId: string
    contactInboxId?: string | null
    ttlHours?: number
    ref?: string
    now?: Date
    tx?: DatabaseClient
  }): Promise<PageLinkModel> {
    const { workspaceId, pageId, contactId, tx = db } = props
    if (props.ref !== undefined && !PAGE_LINK_REF_REGEX.test(props.ref)) {
      throw validationException("ref", "Invalid page link ref")
    }
    const page = await this.get({ workspaceId, id: pageId, tx })
    if (page.status !== "active") {
      throw validationException("pageId", "The page is archived")
    }
    const [contact] = await tx
      .select({ id: contactModel.id })
      .from(contactModel)
      .where(
        and(
          eq(contactModel.id, contactId),
          eq(contactModel.workspaceId, workspaceId),
        ),
      )
      .limit(1)
    if (!contact) {
      throw notFoundException("Contact not found")
    }
    const ttlHours =
      props.ttlHours === undefined
        ? page.linkTtlHours
        : parseTtl(props.ttlHours)
    const now = props.now ?? new Date()
    const ref = props.ref ?? null
    const [inserted] = await tx
      .insert(pageLinkModel)
      .values({
        id: createId(),
        token: mintPageToken(),
        ref,
        expiresAt: new Date(now.getTime() + ttlHours * HOUR_MS),
        workspaceId,
        pageId,
        contactId,
        contactInboxId: props.contactInboxId ?? null,
      })
      .onConflictDoNothing({
        target: [pageLinkModel.pageId, pageLinkModel.ref],
      })
      .returning()
    if (inserted) {
      return inserted
    }
    // Only a ref can conflict (a NULL ref never equals another).
    const [existing] = await tx
      .select()
      .from(pageLinkModel)
      .where(
        and(
          eq(pageLinkModel.pageId, pageId),
          eq(pageLinkModel.ref, ref as string),
        ),
      )
      .limit(1)
    if (!existing || existing.contactId !== contactId) {
      // The same ref for another contact is a caller bug, never a shared link.
      throw validationException("ref", "The ref belongs to another contact")
    }
    return existing
  }

  /**
   * The public lookup behind `/p/<token>`: a malformed token never reaches
   * the database. Order: unknown, expired, archived page.
   */
  async resolveView(props: {
    token: string
    now?: Date
    tx?: DatabaseClient
  }): Promise<PageView> {
    const { token, tx = db } = props
    const now = props.now ?? new Date()
    if (!isPageToken(token)) {
      return { ok: false, reason: "invalid" }
    }
    const [row] = await tx
      .select({ link: pageLinkModel, page: pageModel })
      .from(pageLinkModel)
      .innerJoin(pageModel, eq(pageModel.id, pageLinkModel.pageId))
      .where(eq(pageLinkModel.token, token))
      .limit(1)
    if (!row) {
      return { ok: false, reason: "not-found" }
    }
    if (row.link.expiresAt.getTime() <= now.getTime()) {
      return { ok: false, reason: "expired" }
    }
    if (row.page.status !== "active") {
      return { ok: false, reason: "archived" }
    }
    return { ok: true, link: row.link, page: row.page }
  }

  /**
   * Renders a resolved view for its contact: the stored document is parsed
   * again (never trusted as stored), merge values come from the injected
   * resolver, media only from the workspace library.
   */
  async renderView(props: {
    view: Extract<PageView, { ok: true }>
    appUrl: string
    resolveVariables: ResolveDocumentVariables
    tx?: DatabaseClient
  }): Promise<{ html: string; missing: string[] }> {
    const { view, tx = db } = props
    const document = parseDocument(view.page.document)
    const { tokenNames } = collectRenderInputs(document)
    const [vars, assets, buttons] = await Promise.all([
      props.resolveVariables(tokenNames),
      resolveOwnedAssets(view.page.workspaceId, document, tx),
      buttonUrls({ document, appUrl: props.appUrl, link: view.link }),
    ])
    const rendered = renderWeb(document, {
      vars,
      assets,
      button: (blockId) => buttons.get(blockId) ?? "",
    })
    return {
      html: pageHtml({ title: view.page.name, document, body: rendered.html }),
      missing: rendered.missing,
    }
  }

  /** One atomic increment per view (no read-modify-write race). */
  async recordView(props: {
    linkId: string
    now?: Date
    tx?: DatabaseClient
  }): Promise<void> {
    const { linkId, tx = db } = props
    const now = props.now ?? new Date()
    await tx
      .update(pageLinkModel)
      .set({
        viewCount: sql`${pageLinkModel.viewCount} + 1`,
        firstViewedAt: sql`coalesce(${pageLinkModel.firstViewedAt}, ${now.toISOString()}::timestamptz)`,
        lastViewedAt: now,
      })
      .where(eq(pageLinkModel.id, linkId))
  }

  /**
   * Deletes links expired more than PAGE_LINK_RETAIN_DAYS ago, at most
   * `batch` rows; returns how many went (the schedule loops while it is full).
   */
  async sweepExpired(props?: {
    now?: Date
    batch?: number
    tx?: DatabaseClient
  }): Promise<number> {
    const tx = props?.tx ?? db
    const now = props?.now ?? new Date()
    const batch = props?.batch ?? SWEEP_BATCH
    const cutoff = new Date(now.getTime() - PAGE_LINK_RETAIN_DAYS * DAY_MS)
    const due = tx
      .select({ id: pageLinkModel.id })
      .from(pageLinkModel)
      .where(lt(pageLinkModel.expiresAt, cutoff))
      .limit(batch)
    const deleted = await tx
      .delete(pageLinkModel)
      .where(sql`${pageLinkModel.id} in (${due})`)
      .returning({ id: pageLinkModel.id })
    return deleted.length
  }
}

export const pageService = new PageService()
