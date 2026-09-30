import {
  and,
  type DatabaseClient,
  db,
  desc,
  eq,
  inArray,
  isUniqueViolationError,
} from "@chatbotx.io/database/client"
import {
  EMAIL_TEMPLATE_MAX_NAME,
  type EmailTemplateStatus,
} from "@chatbotx.io/database/partials"
import {
  emailTemplateModel,
  mediaLibraryFileModel,
} from "@chatbotx.io/database/schema"
import type { EmailTemplateModel } from "@chatbotx.io/database/types"
import {
  collectRenderInputs,
  DocumentTooLargeError,
  DocumentValidationError,
  type EmailDocument,
  parseDocument,
  type RenderAsset,
  TemplateError,
} from "@chatbotx.io/email-document"
import { renderEmail } from "@chatbotx.io/email-document/render-email"
import { createId } from "@chatbotx.io/utils"
import { BaseService } from "../base.service"
import { notFoundException, validationException } from "../errors"
import { resolveTenantSettings } from "../platform/settings"
import { getPublicFileUrl } from "../utils"

const TEMPLATE_NOT_FOUND = "Email template not found"
const MAX_BIGINT = 9_223_372_036_854_775_807n

export type EmailTemplateData = { name: unknown; document: unknown }

/** One schema miss, addressed by its path in the document. */
export type DocumentIssue = { path: string; message: string }

export type EmailTemplatePreview =
  | {
      ok: true
      html: string
      text: string
      missing: string[]
      assets: Record<string, RenderAsset>
    }
  | { ok: false; issues: DocumentIssue[] }

/** Issues returned to the editor per preview (the first ones are enough). */
const MAX_PREVIEW_ISSUES = 20

/**
 * The only write path for a template: a trimmed 1..120 name and a document
 * that passes `parseDocument` (closed schema, 256 KB cap). A miss is a 422 on
 * the offending field, never a stored invalid row.
 */
function parseTemplateData(data: EmailTemplateData): {
  name: string
  document: EmailDocument
} {
  if (data === null || typeof data !== "object") {
    throw validationException("name", "Template data is required")
  }
  const name = typeof data.name === "string" ? data.name.trim() : ""
  if (name.length === 0 || name.length > EMAIL_TEMPLATE_MAX_NAME) {
    throw validationException(
      "name",
      `The name must be 1-${EMAIL_TEMPLATE_MAX_NAME} characters`,
    )
  }
  try {
    return { name, document: parseDocument(data.document) }
  } catch (error) {
    if (error instanceof DocumentTooLargeError) {
      throw validationException("document", "The email document is too large")
    }
    if (error instanceof DocumentValidationError) {
      const first = error.issues[0]
      const path = first?.path.map(String).join(".")
      throw validationException(
        "document",
        `Invalid email document${path ? ` at ${path}` : ""}: ${first?.message ?? "invalid"}`,
      )
    }
    throw error
  }
}

/**
 * Every media file a document references (images + attachments) must be a
 * MediaLibraryFile of THIS workspace: a foreign or deleted id is a 422 at
 * save, never a send that later attaches someone else's file or fails.
 */
async function assertAssetsOwned(
  workspaceId: string,
  document: EmailDocument,
  tx: DatabaseClient,
): Promise<void> {
  const { assetIds } = collectRenderInputs(document)
  const found = new Set(
    (await ownedFiles(workspaceId, assetIds, tx)).map((row) => row.id),
  )
  const missing = assetIds.find((id) => !found.has(id))
  if (missing !== undefined) {
    throw validationException(
      "document",
      `Media file ${missing} is not in this workspace's media library`,
    )
  }
}

/** The workspace's media rows among `ids` (a foreign id matches nothing). */
async function ownedFiles(
  workspaceId: string,
  ids: string[],
  tx: DatabaseClient,
) {
  // The schema allows 20 digits; a bigint column holds 19. An id past it
  // matches no row, and must not reach Postgres as an out-of-range 500.
  const queryable = ids.filter((id) => BigInt(id) <= MAX_BIGINT)
  if (queryable.length === 0) {
    return []
  }
  return await tx
    .select({
      id: mediaLibraryFileModel.id,
      name: mediaLibraryFileModel.name,
      path: mediaLibraryFileModel.path,
      size: mediaLibraryFileModel.size,
      mimeType: mediaLibraryFileModel.mimeType,
    })
    .from(mediaLibraryFileModel)
    .where(
      and(
        eq(mediaLibraryFileModel.workspaceId, workspaceId),
        inArray(mediaLibraryFileModel.id, queryable),
      ),
    )
}

function nameTaken(error: unknown): never {
  if (isUniqueViolationError(error)) {
    throw validationException("name", "An email template with this name exists")
  }
  throw error
}

export class EmailTemplateService extends BaseService {
  async list(props: {
    workspaceId: string
    includeArchived?: boolean
    tx?: DatabaseClient
  }): Promise<EmailTemplateModel[]> {
    const { workspaceId, includeArchived = false, tx = db } = props
    return await tx
      .select()
      .from(emailTemplateModel)
      .where(
        includeArchived
          ? eq(emailTemplateModel.workspaceId, workspaceId)
          : and(
              eq(emailTemplateModel.workspaceId, workspaceId),
              eq(emailTemplateModel.status, "active"),
            ),
      )
      .orderBy(desc(emailTemplateModel.updatedAt), desc(emailTemplateModel.id))
  }

  async get(props: {
    workspaceId: string
    id: string
    tx?: DatabaseClient
  }): Promise<EmailTemplateModel> {
    const { workspaceId, id, tx = db } = props
    const [row] = await tx
      .select()
      .from(emailTemplateModel)
      .where(
        and(
          eq(emailTemplateModel.id, id),
          eq(emailTemplateModel.workspaceId, workspaceId),
        ),
      )
      .limit(1)
    if (!row) {
      throw notFoundException(TEMPLATE_NOT_FOUND)
    }
    return row
  }

  /** The stored document, re-validated on read (never trusted as stored). */
  async getDocument(props: {
    workspaceId: string
    id: string
    tx?: DatabaseClient
  }): Promise<EmailDocument> {
    const row = await this.get(props)
    return parseDocument(row.document)
  }

  async create(props: {
    workspaceId: string
    userId?: string | null
    data: EmailTemplateData
    tx?: DatabaseClient
  }): Promise<EmailTemplateModel> {
    const { workspaceId, userId = null, tx = db } = props
    const data = parseTemplateData(props.data)
    await assertAssetsOwned(workspaceId, data.document, tx)
    const [row] = await tx
      .insert(emailTemplateModel)
      .values({
        id: createId(),
        workspaceId,
        createdById: userId,
        status: "active",
        ...data,
      })
      .returning()
      .catch(nameTaken)
    await this.audit("create", `created an email template (#${row.id})`)
    return row
  }

  async update(props: {
    workspaceId: string
    id: string
    data: EmailTemplateData
    tx?: DatabaseClient
  }): Promise<EmailTemplateModel> {
    const { workspaceId, id, tx = db } = props
    const data = parseTemplateData(props.data)
    await assertAssetsOwned(workspaceId, data.document, tx)
    const [row] = await tx
      .update(emailTemplateModel)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(emailTemplateModel.id, id),
          eq(emailTemplateModel.workspaceId, workspaceId),
        ),
      )
      .returning()
      .catch(nameTaken)
    if (!row) {
      throw notFoundException(TEMPLATE_NOT_FOUND)
    }
    await this.audit("update", `updated an email template (#${row.id})`)
    return row
  }

  /**
   * Renders a draft exactly as a send would (renderEmail: MJML, sanitized),
   * with sample merge values and none of the per-recipient callbacks, so
   * tracked links stay raw and flow buttons render as "#". A schema miss is
   * NOT an error here: the editor calls this on every change and highlights
   * each issue's path. Assets resolve only from this workspace's library;
   * any other id is reported in `missing`, never rendered.
   */
  async preview(props: {
    workspaceId: string
    document: unknown
    vars?: Record<string, string>
    tx?: DatabaseClient
  }): Promise<EmailTemplatePreview> {
    const { workspaceId, tx = db } = props
    let document: EmailDocument
    try {
      document = parseDocument(props.document)
    } catch (error) {
      if (error instanceof DocumentTooLargeError) {
        return {
          ok: false,
          issues: [{ path: "", message: "The email document is too large" }],
        }
      }
      if (error instanceof DocumentValidationError) {
        return {
          ok: false,
          issues: error.issues.slice(0, MAX_PREVIEW_ISSUES).map((issue) => ({
            path: issue.path.map(String).join("."),
            message: issue.message,
          })),
        }
      }
      throw error
    }
    const { assetIds, invalid } = collectRenderInputs(document)
    // s227b: a Liquid template that cannot render is an editor issue, never
    // a 500 - a send of the same document fails closed as content.
    if (invalid) {
      return {
        ok: false,
        issues: [{ path: "", message: `Merge template: ${invalid}` }],
      }
    }
    const rows = await ownedFiles(workspaceId, assetIds, tx)
    const assets: Record<string, RenderAsset> = {}
    if (rows.length > 0) {
      const { storageUrl } = await resolveTenantSettings({ workspaceId })
      for (const row of rows) {
        assets[row.id] = {
          url: getPublicFileUrl(row.path, storageUrl),
          name: row.name,
          size: row.size,
          mimeType: row.mimeType,
        }
      }
    }
    let rendered: Awaited<ReturnType<typeof renderEmail>>
    try {
      rendered = await renderEmail(document, {
        vars: props.vars ?? {},
        assets,
      })
    } catch (error) {
      if (error instanceof TemplateError) {
        return {
          ok: false,
          issues: [{ path: "", message: `Merge template: ${error.message}` }],
        }
      }
      throw error
    }
    return {
      ok: true,
      html: rendered.html,
      text: rendered.text,
      missing: rendered.missing,
      assets,
    }
  }

  async setStatus(props: {
    workspaceId: string
    id: string
    status: EmailTemplateStatus
    tx?: DatabaseClient
  }): Promise<EmailTemplateModel> {
    const { workspaceId, id, status, tx = db } = props
    const [row] = await tx
      .update(emailTemplateModel)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(emailTemplateModel.id, id),
          eq(emailTemplateModel.workspaceId, workspaceId),
        ),
      )
      .returning()
    if (!row) {
      throw notFoundException(TEMPLATE_NOT_FOUND)
    }
    await this.audit(
      "update",
      `${status === "archived" ? "archived" : "restored"} an email template (#${row.id})`,
    )
    return row
  }

  async delete(props: {
    workspaceId: string
    id: string
    tx?: DatabaseClient
  }): Promise<void> {
    const { workspaceId, id, tx = db } = props
    const deleted = await tx
      .delete(emailTemplateModel)
      .where(
        and(
          eq(emailTemplateModel.id, id),
          eq(emailTemplateModel.workspaceId, workspaceId),
        ),
      )
      .returning({ id: emailTemplateModel.id })
    if (deleted.length === 0) {
      throw notFoundException(TEMPLATE_NOT_FOUND)
    }
    await this.audit("delete", `deleted an email template (#${id})`)
  }
}

export const emailTemplateService = new EmailTemplateService()
