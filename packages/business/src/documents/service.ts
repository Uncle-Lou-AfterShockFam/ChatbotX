import {
  and,
  type DatabaseClient,
  db,
  desc,
  eq,
  gte,
  like,
  notLike,
} from "@chatbotx.io/database/client"
import {
  CONTACT_DOCUMENT_LINK_TTL_DAYS,
  CONTACT_DOCUMENT_REF_REGEX,
  DOCUMENT_GENERATE_PER_MINUTE,
  DOCUMENT_TEMPLATE_MAX_HTML_BYTES,
  DOCUMENT_TEMPLATE_MAX_NAME,
  type DocumentTemplateStatus,
  INVOICE_DOCUMENT_GENERATE_PER_MINUTE,
  INVOICE_DOCUMENT_REF_PREFIX,
} from "@chatbotx.io/database/partials"
import {
  contactDocumentModel,
  contactModel,
  documentTemplateModel,
} from "@chatbotx.io/database/schema"
import type {
  ContactDocumentModel,
  DocumentTemplateModel,
} from "@chatbotx.io/database/types"
import { uploader } from "@chatbotx.io/filesystem"
import { createId, isBase62Token, mintBase62Token } from "@chatbotx.io/utils"
import { BaseService } from "../base.service"
import { notFoundException, validationException } from "../errors"
import { htmlToPdf } from "./gotenberg"
import {
  DocumentMergeError,
  documentVariables,
  mergeDocumentHtml,
  unsafeTemplateMarkup,
  wrapDocumentHtml,
} from "./html"
import { contactDocumentPath } from "./paths"

const TEMPLATE_NOT_FOUND = "Document template not found"
const DOCUMENT_NOT_FOUND = "Document not found"
const CONTACT_NOT_FOUND = "Contact not found"
const DAY_MS = 86_400_000

/** Base62, 22 characters = 128 random bits: the only secret in `/f/<token>`. */
export const CONTACT_DOCUMENT_TOKEN_LENGTH = 22

export const isContactDocumentToken = (value: unknown): value is string =>
  isBase62Token(value, CONTACT_DOCUMENT_TOKEN_LENGTH)

export const mintContactDocumentToken = (
  random?: (bytes: number) => Uint8Array,
): string => mintBase62Token(16, CONTACT_DOCUMENT_TOKEN_LENGTH, random)

/**
 * Resolves the `{{variable}}` keys of a template for one contact. Injected by
 * the caller (builder API, worker step) because the variable resolvers live in
 * `@chatbotx.io/variables`, which depends on this package.
 */
export type ResolveDocumentVariables = (
  keys: string[],
) => Promise<Record<string, string>>

export type DocumentTemplateData = {
  name: string
  bodyHtml: string
}

const parseTemplateData = (
  data: DocumentTemplateData,
): DocumentTemplateData => {
  const name = typeof data?.name === "string" ? data.name.trim() : ""
  if (name === "" || name.length > DOCUMENT_TEMPLATE_MAX_NAME) {
    throw validationException(
      "name",
      `Name must be 1-${DOCUMENT_TEMPLATE_MAX_NAME} characters`,
    )
  }
  const bodyHtml = typeof data?.bodyHtml === "string" ? data.bodyHtml : ""
  if (bodyHtml.trim() === "") {
    throw validationException("bodyHtml", "The document is empty")
  }
  if (
    new TextEncoder().encode(bodyHtml).length > DOCUMENT_TEMPLATE_MAX_HTML_BYTES
  ) {
    throw validationException("bodyHtml", "The document is too large")
  }
  const unsafe = unsafeTemplateMarkup(bodyHtml)
  if (unsafe !== null) {
    throw validationException(
      "bodyHtml",
      `The document contains unsupported markup (${unsafe})`,
    )
  }
  return { name, bodyHtml }
}

export class DocumentService extends BaseService {
  // ---- templates -------------------------------------------------------

  async listTemplates(props: {
    workspaceId: string
    includeArchived?: boolean
    tx?: DatabaseClient
  }): Promise<DocumentTemplateModel[]> {
    const { workspaceId, includeArchived = false, tx = db } = props
    return await tx
      .select()
      .from(documentTemplateModel)
      .where(
        includeArchived
          ? eq(documentTemplateModel.workspaceId, workspaceId)
          : and(
              eq(documentTemplateModel.workspaceId, workspaceId),
              eq(documentTemplateModel.status, "active"),
            ),
      )
      .orderBy(
        desc(documentTemplateModel.updatedAt),
        desc(documentTemplateModel.id),
      )
  }

  async getTemplate(props: {
    workspaceId: string
    id: string
    tx?: DatabaseClient
  }): Promise<DocumentTemplateModel> {
    const { workspaceId, id, tx = db } = props
    const [row] = await tx
      .select()
      .from(documentTemplateModel)
      .where(
        and(
          eq(documentTemplateModel.id, id),
          eq(documentTemplateModel.workspaceId, workspaceId),
        ),
      )
      .limit(1)
    if (!row) {
      throw notFoundException(TEMPLATE_NOT_FOUND)
    }
    return row
  }

  async createTemplate(props: {
    workspaceId: string
    userId?: string | null
    data: DocumentTemplateData
    tx?: DatabaseClient
  }): Promise<DocumentTemplateModel> {
    const { workspaceId, userId = null, tx = db } = props
    const data = parseTemplateData(props.data)
    const [row] = await tx
      .insert(documentTemplateModel)
      .values({
        id: createId(),
        workspaceId,
        createdById: userId,
        status: "active",
        ...data,
      })
      .returning()
    return row
  }

  async updateTemplate(props: {
    workspaceId: string
    id: string
    data: DocumentTemplateData
    tx?: DatabaseClient
  }): Promise<DocumentTemplateModel> {
    const { workspaceId, id, tx = db } = props
    const data = parseTemplateData(props.data)
    const [row] = await tx
      .update(documentTemplateModel)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(documentTemplateModel.id, id),
          eq(documentTemplateModel.workspaceId, workspaceId),
        ),
      )
      .returning()
    if (!row) {
      throw notFoundException(TEMPLATE_NOT_FOUND)
    }
    return row
  }

  async setTemplateStatus(props: {
    workspaceId: string
    id: string
    status: DocumentTemplateStatus
    tx?: DatabaseClient
  }): Promise<DocumentTemplateModel> {
    const { workspaceId, id, status, tx = db } = props
    const [row] = await tx
      .update(documentTemplateModel)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(documentTemplateModel.id, id),
          eq(documentTemplateModel.workspaceId, workspaceId),
        ),
      )
      .returning()
    if (!row) {
      throw notFoundException(TEMPLATE_NOT_FOUND)
    }
    return row
  }

  /** Hard delete; generated documents keep their PDF and title (templateId -> null). */
  async deleteTemplate(props: {
    workspaceId: string
    id: string
    tx?: DatabaseClient
  }): Promise<void> {
    const { workspaceId, id, tx = db } = props
    const deleted = await tx
      .delete(documentTemplateModel)
      .where(
        and(
          eq(documentTemplateModel.id, id),
          eq(documentTemplateModel.workspaceId, workspaceId),
        ),
      )
      .returning({ id: documentTemplateModel.id })
    if (deleted.length === 0) {
      throw notFoundException(TEMPLATE_NOT_FOUND)
    }
  }

  // ---- contact documents -----------------------------------------------

  async listForContact(props: {
    workspaceId: string
    contactId: string
    limit?: number
    tx?: DatabaseClient
  }): Promise<ContactDocumentModel[]> {
    const { workspaceId, contactId, limit = 100, tx = db } = props
    return await tx
      .select()
      .from(contactDocumentModel)
      .where(
        and(
          eq(contactDocumentModel.workspaceId, workspaceId),
          eq(contactDocumentModel.contactId, contactId),
        ),
      )
      .orderBy(
        desc(contactDocumentModel.createdAt),
        desc(contactDocumentModel.id),
      )
      .limit(Math.min(Math.max(limit, 1), 500))
  }

  /**
   * Render `templateId` for one contact and store the PDF on the contact.
   * Idempotent per `(contactId, ref)`: a second call with the same ref returns
   * the stored row (`created: false`) without rendering. Concurrent calls with
   * one ref race on the unique index: the loser deletes its orphan object and
   * returns the winner's row. Gotenberg or storage failures throw a
   * `validationException` naming what failed (the caller surfaces it).
   */
  async generateForContact(props: {
    workspaceId: string
    contactId: string
    templateId: string
    ref?: string
    resolveVariables: ResolveDocumentVariables
    now?: Date
    tx?: DatabaseClient
  }): Promise<{ document: ContactDocumentModel; created: boolean }> {
    const {
      workspaceId,
      contactId,
      templateId,
      resolveVariables,
      tx = db,
    } = props
    const now = props.now ?? new Date()
    const ref = props.ref ?? `manual:${createId()}`
    if (!CONTACT_DOCUMENT_REF_REGEX.test(ref)) {
      throw validationException(
        "ref",
        "ref must be 1-100 of A-Z a-z 0-9 . _ : -",
      )
    }
    // The hub's invoice PDFs are served by pay link: never plant one.
    if (ref.startsWith(INVOICE_DOCUMENT_REF_PREFIX)) {
      throw validationException(
        "ref",
        `refs starting with "${INVOICE_DOCUMENT_REF_PREFIX}" are reserved`,
      )
    }
    const existing = await this.findByRef({ contactId, ref, tx })
    if (existing) {
      if (existing.workspaceId !== workspaceId) {
        throw notFoundException(CONTACT_NOT_FOUND)
      }
      return { document: existing, created: false }
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
      throw notFoundException(CONTACT_NOT_FOUND)
    }
    await this.assertGenerateBudget({ workspaceId, now, tx })
    const template = await this.getTemplate({ workspaceId, id: templateId, tx })
    if (template.status !== "active") {
      throw validationException("templateId", "This template is archived")
    }

    let html: string
    try {
      const mapping = await resolveVariables(
        documentVariables(template.bodyHtml),
      )
      html = wrapDocumentHtml(
        template.name,
        mergeDocumentHtml(template.bodyHtml, mapping),
      )
    } catch (err) {
      if (err instanceof DocumentMergeError) {
        throw validationException("templateId", err.message)
      }
      throw err
    }
    return await this.storeRenderedPdf({
      workspaceId,
      contactId,
      templateId,
      title: template.name,
      ref,
      html,
      field: "templateId",
      now,
      tx,
    })
  }

  /**
   * Render `html` and store it as the contact's `ref` document: Gotenberg,
   * the private object, then the row. The (contactId, ref) unique index
   * arbitrates a race: the loser deletes its orphan object and returns the
   * winner's row. Failures throw a `validationException` on `field`. The
   * caller has already looked up `ref` and passed the generate budget.
   */
  async storeRenderedPdf(props: {
    workspaceId: string
    contactId: string
    templateId: string | null
    title: string
    ref: string
    html: string
    field: string
    now: Date
    tx: DatabaseClient
  }): Promise<{ document: ContactDocumentModel; created: boolean }> {
    const { workspaceId, contactId, templateId, title, ref, field, now, tx } =
      props
    const rendered = await htmlToPdf(props.html)
    if (!rendered.ok) {
      throw validationException(
        field,
        `Could not render the PDF (${rendered.error})`,
      )
    }

    const id = createId()
    const path = contactDocumentPath(workspaceId, contactId, id)
    try {
      await uploader.putObject(path, rendered.pdf, {
        ContentType: "application/pdf",
      })
    } catch {
      throw validationException(field, "Could not store the PDF")
    }
    let row: ContactDocumentModel | undefined
    try {
      ;[row] = await tx
        .insert(contactDocumentModel)
        .values({
          id,
          workspaceId,
          contactId,
          templateId,
          title,
          ref,
          status: "generated",
          path,
          fileSize: rendered.pdf.length,
          token: mintContactDocumentToken(),
          tokenExpiresAt: new Date(
            now.getTime() + CONTACT_DOCUMENT_LINK_TTL_DAYS * DAY_MS,
          ),
        })
        .onConflictDoNothing({
          target: [contactDocumentModel.contactId, contactDocumentModel.ref],
        })
        .returning()
    } catch (err) {
      // Any insert failure (a template deleted mid-render, a token collision):
      // the stored object has no row, so it goes too.
      await uploader.deleteObject(path).catch(() => undefined)
      throw err
    }
    if (row) {
      return { document: row, created: true }
    }
    // Lost the race for this ref: drop our object, answer with the winner.
    await uploader.deleteObject(path).catch(() => undefined)
    const winner = await this.findByRef({ contactId, ref, tx })
    if (!winner) {
      throw notFoundException(DOCUMENT_NOT_FOUND)
    }
    return { document: winner, created: false }
  }

  /**
   * 429-style refusal past the per-minute renders of this workspace: template
   * documents (DOCUMENT_GENERATE_PER_MINUTE) and invoice PDFs
   * (INVOICE_DOCUMENT_GENERATE_PER_MINUTE) are counted apart.
   */
  async assertGenerateBudget(props: {
    workspaceId: string
    now: Date
    tx: DatabaseClient
    kind?: "template" | "invoice"
  }): Promise<void> {
    const { workspaceId, now, tx, kind = "template" } = props
    const invoice = kind === "invoice"
    const field = invoice ? "invoice" : "templateId"
    const limit = invoice
      ? INVOICE_DOCUMENT_GENERATE_PER_MINUTE
      : DOCUMENT_GENERATE_PER_MINUTE
    const prefix = `${INVOICE_DOCUMENT_REF_PREFIX}%`
    const recent = await tx
      .select({ id: contactDocumentModel.id })
      .from(contactDocumentModel)
      .where(
        and(
          eq(contactDocumentModel.workspaceId, workspaceId),
          gte(contactDocumentModel.createdAt, new Date(now.getTime() - 60_000)),
          invoice
            ? like(contactDocumentModel.ref, prefix)
            : notLike(contactDocumentModel.ref, prefix),
        ),
      )
      .limit(limit)
    if (recent.length >= limit) {
      throw validationException(
        field,
        `Too many documents generated in the last minute (limit ${limit}); try again shortly`,
      )
    }
  }

  async findByRef(props: {
    contactId: string
    ref: string
    tx: DatabaseClient
  }): Promise<ContactDocumentModel | undefined> {
    const { contactId, ref, tx } = props
    const [row] = await tx
      .select()
      .from(contactDocumentModel)
      .where(
        and(
          eq(contactDocumentModel.contactId, contactId),
          eq(contactDocumentModel.ref, ref),
        ),
      )
      .limit(1)
    return row
  }

  /**
   * The public `/f/<token>` lookup: the row when the token is well-formed,
   * known, not expired and has a file; otherwise the reason.
   */
  async resolveDownload(props: {
    token: string
    now?: Date
    tx?: DatabaseClient
  }): Promise<
    | { ok: true; document: ContactDocumentModel; path: string }
    | { ok: false; reason: "invalid" | "not-found" | "expired" | "no-file" }
  > {
    const { token, tx = db } = props
    const now = props.now ?? new Date()
    if (!isContactDocumentToken(token)) {
      return { ok: false, reason: "invalid" }
    }
    const [row] = await tx
      .select()
      .from(contactDocumentModel)
      .where(eq(contactDocumentModel.token, token))
      .limit(1)
    if (!row) {
      return { ok: false, reason: "not-found" }
    }
    if (row.tokenExpiresAt.getTime() <= now.getTime()) {
      return { ok: false, reason: "expired" }
    }
    // A signed copy, once there, is the document the person should see.
    const path = row.signedPath || row.path
    if (!path) {
      return { ok: false, reason: "no-file" }
    }
    return { ok: true, document: row, path }
  }
}

export const documentService = new DocumentService()
