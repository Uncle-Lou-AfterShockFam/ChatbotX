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
  DocumentTooLargeError,
  DocumentValidationError,
  type EmailDocument,
  parseDocument,
} from "@chatbotx.io/email-document"
import { createId } from "@chatbotx.io/utils"
import { BaseService } from "../base.service"
import { notFoundException, validationException } from "../errors"

const TEMPLATE_NOT_FOUND = "Email template not found"

export type EmailTemplateData = { name: unknown; document: unknown }

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
