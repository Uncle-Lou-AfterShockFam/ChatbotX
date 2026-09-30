import {
  and,
  type DatabaseClient,
  db,
  desc,
  eq,
  isUniqueViolationError,
} from "@chatbotx.io/database/client"
import {
  EMAIL_TEMPLATE_MAX_NAME,
  type EmailTemplateStatus,
} from "@chatbotx.io/database/partials"
import { emailTemplateModel } from "@chatbotx.io/database/schema"
import type { EmailTemplateModel } from "@chatbotx.io/database/types"
import {
  type EmailDocument,
  parseDocument,
  type RenderAsset,
  TemplateError,
} from "@chatbotx.io/email-document"
import { renderEmail } from "@chatbotx.io/email-document/render-email"
import { createId } from "@chatbotx.io/utils"
import { BaseService } from "../base.service"
import { notFoundException, validationException } from "../errors"
import {
  assertAssetsOwned,
  type DocumentIssue,
  parseNamedDocument,
  parsePreviewDocument,
  resolveOwnedAssets,
} from "./document-data"

const TEMPLATE_NOT_FOUND = "Email template not found"

export type EmailTemplateData = { name: unknown; document: unknown }

export type { DocumentIssue } from "./document-data"

export type EmailTemplatePreview =
  | {
      ok: true
      html: string
      text: string
      missing: string[]
      assets: Record<string, RenderAsset>
    }
  | { ok: false; issues: DocumentIssue[] }

/** The only write path for a template (see parseNamedDocument). */
const parseTemplateData = (data: EmailTemplateData) =>
  parseNamedDocument(data, EMAIL_TEMPLATE_MAX_NAME, "email document")

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
    const parsed = parsePreviewDocument(props.document, "email document")
    if (!parsed.ok) {
      return parsed
    }
    const { document } = parsed
    const assets = await resolveOwnedAssets(workspaceId, document, tx)
    let rendered: Awaited<ReturnType<typeof renderEmail>>
    try {
      rendered = await renderEmail(document, {
        vars: props.vars ?? {},
        assets,
      })
    } catch (error) {
      // s227b: a Liquid render limit is an editor issue, never a 500.
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
