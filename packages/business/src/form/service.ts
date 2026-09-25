import {
  and,
  type DatabaseClient,
  db,
  desc,
  eq,
  isUniqueViolationError,
  type SQL,
  sql,
} from "@chatbotx.io/database/client"
import {
  DEFAULT_FORM_SETTINGS,
  EMPTY_FORM_DEFINITION,
  FORM_MAX_TITLE,
  FORM_SLUG_REGEX,
  type FormDefinition,
  type FormSettings,
  type FormStatus,
  formIdentifiesContact,
  formInputFields,
  formMapsToContact,
  normalizeFormDefinition,
  normalizeFormSettings,
  parseFormDefinition,
  parseFormSettings,
  slugifyFormTitle,
} from "@chatbotx.io/database/partials"
import {
  customFieldModel,
  formModel,
  formSubmissionModel,
  inboxModel,
} from "@chatbotx.io/database/schema"
import type {
  FormModel,
  FormSubmissionModel,
} from "@chatbotx.io/database/types"
import { createId } from "@chatbotx.io/utils"
import { BaseService } from "../base.service"
import {
  ChatbotXException,
  notFoundException,
  validationException,
} from "../errors"

const FORM_NOT_FOUND = "Form not found"
const SUBMISSION_NOT_FOUND = "Submission not found"
const SLUG_TAKEN = "That slug is already used by another form."
const SLUG_UNIQUE_INDEX = "Form_workspaceId_slug_key"
const MAX_DUPLICATE_ATTEMPTS = 5
const INT8_ID = /^\d{1,19}$/

/** Someone else saved since the caller loaded the form (optimistic lock). */
const conflictException = () =>
  new ChatbotXException(
    "This form changed since you loaded it. Reload and apply your edits again.",
    "conflict",
    409,
  )

export type FormWriteData = {
  title?: string
  slug?: string
  definition?: unknown
  settings?: unknown
  inboxId?: string | null
}

const normalizeSubmission = (row: FormSubmissionModel): FormSubmissionModel => {
  const values =
    row.values !== null &&
    typeof row.values === "object" &&
    !Array.isArray(row.values)
      ? row.values
      : {}
  const raw = row.visibility as { steps?: unknown; fields?: unknown } | null
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  return {
    ...row,
    values,
    visibility: { steps: list(raw?.steps), fields: list(raw?.fields) },
  }
}

/** A form as every read path returns it: jsonb normalised, never raw. */
export type NormalizedForm = Omit<
  FormModel,
  "definition" | "publishedDefinition" | "settings"
> & {
  definition: FormDefinition
  publishedDefinition: FormDefinition | null
  settings: FormSettings
}

export type FormSummary = NormalizedForm & { submissionCount: number }

type SubmissionCursor = { k: string; i: string }
export const FORM_SUBMISSION_CURSOR_MAX_LENGTH = 256
const INT8_TEXT = /^\d{1,19}$/
const INT8_MAX = 2n ** 63n - 1n

const isInt8 = (value: unknown): value is string =>
  typeof value === "string" &&
  INT8_TEXT.test(value) &&
  BigInt(value) <= INT8_MAX

/** Epoch microseconds as int8 text (s198 rule: never `::text` on a timestamp). */
const createdAtMicros = sql<string>`(extract(epoch from ${formSubmissionModel.createdAt}) * 1000000)::bigint::text`

export function encodeSubmissionCursor(c: SubmissionCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url")
}

export function decodeSubmissionCursor(raw: string): SubmissionCursor {
  const refuse = () =>
    validationException("cursor", "That page cursor is not valid.", {
      reason: "invalidCursor",
    })
  if (
    typeof raw !== "string" ||
    raw.length > FORM_SUBMISSION_CURSOR_MAX_LENGTH
  ) {
    throw refuse()
  }
  let c: unknown
  try {
    c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
  } catch {
    throw refuse()
  }
  if (!c || typeof c !== "object" || Array.isArray(c)) {
    throw refuse()
  }
  const { k, i, ...rest } = c as Record<string, unknown>
  if (Object.keys(rest).length > 0 || !isInt8(k) || !isInt8(i)) {
    throw refuse()
  }
  return { k, i }
}

const parseTitle = (raw: unknown): string => {
  const title = typeof raw === "string" ? raw.trim() : ""
  if (title === "" || title.length > FORM_MAX_TITLE) {
    throw validationException(
      "title",
      `Title must be 1-${FORM_MAX_TITLE} characters.`,
    )
  }
  return title
}

const parseSlug = (raw: unknown): string => {
  const slug = typeof raw === "string" ? raw.trim().toLowerCase() : ""
  if (!FORM_SLUG_REGEX.test(slug)) {
    throw validationException(
      "slug",
      "Slug: lower-case letters, digits and dashes, 1-64 characters, no dash at either end.",
    )
  }
  return slug
}

export class FormService extends BaseService {
  normalize(row: FormModel): NormalizedForm {
    return {
      ...row,
      definition: normalizeFormDefinition(row.definition),
      publishedDefinition:
        row.publishedDefinition === null
          ? null
          : normalizeFormDefinition(row.publishedDefinition),
      settings: normalizeFormSettings(row.settings),
    }
  }

  // ---- forms ------------------------------------------------------------

  async list(props: {
    workspaceId: string
    includeArchived?: boolean
    tx?: DatabaseClient
  }): Promise<FormSummary[]> {
    const { workspaceId, includeArchived = false, tx = db } = props
    const counts = tx
      .select({
        formId: formSubmissionModel.formId,
        count: sql<number>`count(*)::int`.as("count"),
      })
      .from(formSubmissionModel)
      .where(eq(formSubmissionModel.workspaceId, workspaceId))
      .groupBy(formSubmissionModel.formId)
      .as("counts")
    const rows = await tx
      .select({
        form: formModel,
        submissionCount: sql<number>`coalesce(${counts.count}, 0)`,
      })
      .from(formModel)
      .leftJoin(counts, eq(counts.formId, formModel.id))
      .where(
        includeArchived
          ? eq(formModel.workspaceId, workspaceId)
          : and(
              eq(formModel.workspaceId, workspaceId),
              sql`${formModel.status} <> 'archived'`,
            ),
      )
      .orderBy(desc(formModel.updatedAt), desc(formModel.id))
    return rows.map((r) => ({
      ...this.normalize(r.form),
      submissionCount: Number(r.submissionCount ?? 0),
    }))
  }

  async get(props: {
    workspaceId: string
    id: string
    tx?: DatabaseClient
  }): Promise<NormalizedForm> {
    const { workspaceId, id, tx = db } = props
    const [row] = await tx
      .select()
      .from(formModel)
      .where(and(eq(formModel.id, id), eq(formModel.workspaceId, workspaceId)))
      .limit(1)
    if (!row) {
      throw notFoundException(FORM_NOT_FOUND)
    }
    return this.normalize(row)
  }

  /** The PUBLISHED form behind a public URL, or null (draft / archived / unknown). */
  async findPublishedBySlug(props: {
    workspaceId: string
    slug: string
    tx?: DatabaseClient
  }): Promise<NormalizedForm | null> {
    const { workspaceId, tx = db } = props
    if (!FORM_SLUG_REGEX.test(props.slug)) {
      return null
    }
    const [row] = await tx
      .select()
      .from(formModel)
      .where(
        and(
          eq(formModel.workspaceId, workspaceId),
          eq(formModel.slug, props.slug),
          eq(formModel.status, "published"),
        ),
      )
      .limit(1)
    if (!row || row.publishedDefinition === null) {
      return null
    }
    const form = this.normalize(row)
    // A published form always has an input field (publish refuses an empty
    // one), so a normalised-to-empty copy is a corrupt row: fail closed.
    if (
      formInputFields(form.publishedDefinition ?? EMPTY_FORM_DEFINITION)
        .length === 0
    ) {
      return null
    }
    return form
  }

  async create(props: {
    workspaceId: string
    userId?: string | null
    data: { title: unknown; slug?: unknown }
    tx?: DatabaseClient
  }): Promise<NormalizedForm> {
    const { workspaceId, userId = null, tx = db } = props
    const title = parseTitle(props.data.title)
    const slug =
      props.data.slug === undefined || props.data.slug === ""
        ? slugifyFormTitle(title)
        : parseSlug(props.data.slug)
    try {
      const [row] = await tx
        .insert(formModel)
        .values({
          id: createId(),
          workspaceId,
          createdById: userId,
          title,
          slug,
          status: "draft",
          definition: { ...EMPTY_FORM_DEFINITION },
          publishedDefinition: null,
          definitionVersion: 0,
          settings: { ...DEFAULT_FORM_SETTINGS },
        })
        .returning()
      return this.normalize(row)
    } catch (error) {
      if (isUniqueViolationError(error, SLUG_UNIQUE_INDEX)) {
        throw validationException("slug", SLUG_TAKEN)
      }
      throw error
    }
  }

  /**
   * Save the draft. Strict on every jsonb: an unknown key, a cap, a dangling
   * condition reference or a bad origin is a 422 naming the path. A form
   * whose fields write to a contact needs an API-channel inbox of this
   * workspace. Renaming the slug of a PUBLISHED form breaks live links, so
   * it is refused unless `force`.
   */
  async update(props: {
    workspaceId: string
    id: string
    data: FormWriteData
    force?: boolean
    /** The `updatedAt` the caller loaded; a newer row is a 409, never overwritten. */
    ifUnmodifiedSince?: Date | null
    tx?: DatabaseClient
  }): Promise<NormalizedForm> {
    const { workspaceId, id, data, force = false, tx = db } = props
    const current = await this.get({ workspaceId, id, tx })
    if (
      props.ifUnmodifiedSince &&
      current.updatedAt.getTime() !== props.ifUnmodifiedSince.getTime()
    ) {
      throw conflictException()
    }
    const patch: Partial<typeof formModel.$inferInsert> = {}

    if (data.title !== undefined) {
      patch.title = parseTitle(data.title)
    }
    if (data.slug !== undefined) {
      const slug = parseSlug(data.slug)
      if (slug !== current.slug) {
        if (current.status === "published" && !force) {
          throw validationException(
            "slug",
            "This form is published; changing its slug breaks the live link.",
            { reason: "publishedSlug" },
          )
        }
        patch.slug = slug
      }
    }
    let definition = current.definition
    if (data.definition !== undefined) {
      const parsed = parseFormDefinition(data.definition)
      if (!parsed.success) {
        throw validationException(
          parsed.path === "" ? "definition" : `definition.${parsed.path}`,
          parsed.message,
        )
      }
      definition = parsed.data
      patch.definition = definition
    }
    if (data.settings !== undefined) {
      if (data.settings === null || typeof data.settings !== "object") {
        throw validationException("settings", "Settings must be an object.")
      }
      const parsed = parseFormSettings(data.settings)
      if (!parsed.success) {
        throw validationException(
          parsed.path === "" ? "settings" : `settings.${parsed.path}`,
          parsed.message,
        )
      }
      patch.settings = parsed.data
    }
    const inboxId = data.inboxId === undefined ? current.inboxId : data.inboxId
    if (data.inboxId !== undefined) {
      if (inboxId !== null && !INT8_ID.test(inboxId)) {
        throw validationException("inboxId", "That inbox does not exist here.")
      }
      patch.inboxId = inboxId
    }
    if (inboxId !== null) {
      await this.assertApiInbox({ workspaceId, inboxId, tx })
    }
    if (formMapsToContact(definition) && inboxId === null) {
      throw validationException(
        "inboxId",
        "Pick an API-channel inbox: a field on this form writes to the contact.",
        { reason: "inboxRequired" },
      )
    }
    if (Object.keys(patch).length === 0) {
      return current
    }
    try {
      const [row] = await tx
        .update(formModel)
        .set({ ...patch, updatedAt: new Date() })
        .where(
          and(
            eq(formModel.id, id),
            eq(formModel.workspaceId, workspaceId),
            eq(formModel.updatedAt, current.updatedAt),
          ),
        )
        .returning()
      if (!row) {
        // The read above found it: 0 rows means it moved under us.
        throw conflictException()
      }
      return this.normalize(row)
    } catch (error) {
      if (isUniqueViolationError(error, SLUG_UNIQUE_INDEX)) {
        throw validationException("slug", SLUG_TAKEN)
      }
      throw error
    }
  }

  /**
   * Copy the draft to `publishedDefinition` (version + 1). Refused when the
   * form is archived, has no input field, maps a contact without a way to
   * identify one (phone or email), maps a custom field that no longer
   * exists, or maps a contact without an inbox.
   */
  async publish(props: {
    workspaceId: string
    id: string
    tx?: DatabaseClient
  }): Promise<NormalizedForm> {
    const { workspaceId, id, tx = db } = props
    const current = await this.get({ workspaceId, id, tx })
    if (current.status === "archived") {
      throw validationException(
        "status",
        "Restore the form before publishing it.",
      )
    }
    const def = current.definition
    const inputs = formInputFields(def)
    if (inputs.length === 0) {
      throw validationException("definition", "Add at least one field first.")
    }
    if (formMapsToContact(def)) {
      if (!formIdentifiesContact(def)) {
        throw validationException(
          "definition",
          "A form that writes to a contact needs a phone or email field mapped to the contact.",
          { reason: "noIdentity" },
        )
      }
      if (current.inboxId === null) {
        throw validationException(
          "inboxId",
          "Pick an API-channel inbox before publishing.",
          { reason: "inboxRequired" },
        )
      }
      await this.assertApiInbox({ workspaceId, inboxId: current.inboxId, tx })
      const customIds = inputs
        .map((f) => (f.mapTo?.kind === "custom" ? f.mapTo.customFieldId : null))
        .filter((v): v is string => v !== null)
      if (customIds.length > 0) {
        const found = await tx
          .select({ id: customFieldModel.id })
          .from(customFieldModel)
          .where(
            and(
              eq(customFieldModel.workspaceId, workspaceId),
              sql`${customFieldModel.id} in (${sql.join(
                customIds.map((v) => sql`${v}::bigint`),
                sql`, `,
              )})`,
            ),
          )
        const foundIds = new Set(found.map((r) => String(r.id)))
        const missing = customIds.find((v) => !foundIds.has(v))
        if (missing !== undefined) {
          throw validationException(
            "definition",
            "A mapped custom field no longer exists; re-map or unmap it.",
            { reason: "danglingCustomField", customFieldId: missing },
          )
        }
      }
    }
    const [row] = await tx
      .update(formModel)
      .set({
        status: "published",
        publishedDefinition: def,
        definitionVersion: current.definitionVersion + 1,
        publishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(formModel.id, id),
          eq(formModel.workspaceId, workspaceId),
          eq(formModel.definitionVersion, current.definitionVersion),
          eq(formModel.updatedAt, current.updatedAt),
        ),
      )
      .returning()
    if (!row) {
      throw conflictException()
    }
    return this.normalize(row)
  }

  /** `draft` = unpublish (keeps the last published copy), `archived` = hide. */
  async setStatus(props: {
    workspaceId: string
    id: string
    status: Exclude<FormStatus, "published">
    tx?: DatabaseClient
  }): Promise<NormalizedForm> {
    const { workspaceId, id, status, tx = db } = props
    const [row] = await tx
      .update(formModel)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(formModel.id, id), eq(formModel.workspaceId, workspaceId)))
      .returning()
    if (!row) {
      throw notFoundException(FORM_NOT_FOUND)
    }
    return this.normalize(row)
  }

  /** Hard delete; submissions go with it (FK cascade). */
  async delete(props: {
    workspaceId: string
    id: string
    tx?: DatabaseClient
  }): Promise<void> {
    const { workspaceId, id, tx = db } = props
    const deleted = await tx
      .delete(formModel)
      .where(and(eq(formModel.id, id), eq(formModel.workspaceId, workspaceId)))
      .returning({ id: formModel.id })
    if (deleted.length === 0) {
      throw notFoundException(FORM_NOT_FOUND)
    }
  }

  /** A draft copy `<slug>-copy[-N]` with the same draft definition and settings. */
  async duplicate(props: {
    workspaceId: string
    id: string
    userId?: string | null
    tx?: DatabaseClient
  }): Promise<NormalizedForm> {
    const { workspaceId, id, userId = null, tx = db } = props
    const source = await this.get({ workspaceId, id, tx })
    const base = source.slug.slice(0, 64 - "-copy-9".length)
    for (let attempt = 1; attempt <= MAX_DUPLICATE_ATTEMPTS; attempt++) {
      const slug = attempt === 1 ? `${base}-copy` : `${base}-copy-${attempt}`
      try {
        const [row] = await tx
          .insert(formModel)
          .values({
            id: createId(),
            workspaceId,
            createdById: userId,
            title: `${source.title} (copy)`.slice(0, FORM_MAX_TITLE),
            slug,
            status: "draft",
            definition: source.definition,
            publishedDefinition: null,
            definitionVersion: 0,
            settings: source.settings,
            inboxId: source.inboxId,
          })
          .returning()
        return this.normalize(row)
      } catch (error) {
        if (!isUniqueViolationError(error, SLUG_UNIQUE_INDEX)) {
          throw error
        }
      }
    }
    throw validationException("slug", SLUG_TAKEN)
  }

  private async assertApiInbox(props: {
    workspaceId: string
    inboxId: string
    tx: DatabaseClient
  }): Promise<void> {
    const [inbox] = await props.tx
      .select({ id: inboxModel.id, channel: inboxModel.channel })
      .from(inboxModel)
      .where(
        and(
          eq(inboxModel.id, props.inboxId),
          eq(inboxModel.workspaceId, props.workspaceId),
        ),
      )
      .limit(1)
    if (!inbox) {
      throw validationException("inboxId", "That inbox does not exist here.")
    }
    if (inbox.channel !== "api") {
      throw validationException(
        "inboxId",
        "Forms attach contacts to an API-channel inbox only.",
        { reason: "notApiChannel" },
      )
    }
  }

  // ---- submissions ------------------------------------------------------

  async listSubmissions(props: {
    workspaceId: string
    formId: string
    cursor?: string | null
    limit?: number
    tx?: DatabaseClient
  }): Promise<{ data: FormSubmissionModel[]; nextCursor: string | null }> {
    const { workspaceId, formId, tx = db } = props
    const requested = Number.isInteger(props.limit)
      ? (props.limit as number)
      : 50
    const limit = Math.min(Math.max(requested, 1), 200)
    await this.get({ workspaceId, id: formId, tx })
    const after = props.cursor ? decodeSubmissionCursor(props.cursor) : null
    const conditions: SQL[] = [
      eq(formSubmissionModel.workspaceId, workspaceId),
      eq(formSubmissionModel.formId, formId),
    ]
    if (after) {
      conditions.push(
        sql`(${createdAtMicros}::bigint < ${after.k}::bigint or (${createdAtMicros}::bigint = ${after.k}::bigint and ${formSubmissionModel.id} < ${after.i}::bigint))`,
      )
    }
    const rows = await tx
      .select({ row: formSubmissionModel, k: createdAtMicros })
      .from(formSubmissionModel)
      .where(and(...conditions))
      .orderBy(
        desc(formSubmissionModel.createdAt),
        desc(formSubmissionModel.id),
      )
      .limit(limit + 1)
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return {
      data: page.map((r) => normalizeSubmission(r.row)),
      nextCursor:
        rows.length > limit && last
          ? encodeSubmissionCursor({ k: last.k, i: last.row.id })
          : null,
    }
  }

  async getSubmission(props: {
    workspaceId: string
    formId: string
    id: string
    tx?: DatabaseClient
  }): Promise<FormSubmissionModel> {
    const { workspaceId, formId, id, tx = db } = props
    const [row] = await tx
      .select()
      .from(formSubmissionModel)
      .where(
        and(
          eq(formSubmissionModel.id, id),
          eq(formSubmissionModel.formId, formId),
          eq(formSubmissionModel.workspaceId, workspaceId),
        ),
      )
      .limit(1)
    if (!row) {
      throw notFoundException(SUBMISSION_NOT_FOUND)
    }
    return normalizeSubmission(row)
  }

  async deleteSubmission(props: {
    workspaceId: string
    formId: string
    id: string
    tx?: DatabaseClient
  }): Promise<void> {
    const { workspaceId, formId, id, tx = db } = props
    const deleted = await tx
      .delete(formSubmissionModel)
      .where(
        and(
          eq(formSubmissionModel.id, id),
          eq(formSubmissionModel.formId, formId),
          eq(formSubmissionModel.workspaceId, workspaceId),
        ),
      )
      .returning({ id: formSubmissionModel.id })
    if (deleted.length === 0) {
      throw notFoundException(SUBMISSION_NOT_FOUND)
    }
  }
}

export const formService = new FormService()
