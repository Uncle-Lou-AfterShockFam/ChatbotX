import { randomBytes, randomUUID } from "node:crypto"
import {
  and,
  count,
  type DatabaseClient,
  db,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  sql,
} from "@chatbotx.io/database/client"
import {
  EMPTY_FORM_DEFINITION,
  FORM_UPLOAD_FIELD_TYPES,
  FORM_UPLOAD_ID_REGEX,
  type FormDefinition,
  type FormField,
  formInputFields,
  formUploadMaxBytes,
  formUploadMimeTypes,
} from "@chatbotx.io/database/partials"
import { formUploadModel } from "@chatbotx.io/database/schema"
import type { FormUploadModel } from "@chatbotx.io/database/types"
import { uploader } from "@chatbotx.io/filesystem"
import { createId } from "@chatbotx.io/utils"
import { logger } from "../logger"
import { formUploadsPrefix } from "../storage/paths"
import { sniffUpload } from "../storage/sniff"
import { hashClientIp } from "./ip-hash"
import type { NormalizedForm } from "./service"

/**
 * Private web form uploads (s225a A2-4 PR 5). The public page sends ONE
 * file per `image` / `file` field to the upload route before the submit;
 * `store` sniffs it, writes a pending row, then the object, and answers an
 * opaque `fu_` id the page puts in the field's value. The submit `claim`s
 * its ids inside its own transaction; the sweep deletes what no submission
 * claimed. The object key is ours (`formUploadsPrefix` + a uuid): nothing
 * the caller sends reaches a path.
 */

/** An unclaimed upload older than this is swept (row + object). */
export const FORM_UPLOAD_PENDING_TTL_MS = 24 * 60 * 60_000
/**
 * A submit claims only uploads younger than this: an hour short of the
 * sweep's age, so a claim can never race the sweep deleting the object.
 */
export const FORM_UPLOAD_CLAIM_TTL_MS = FORM_UPLOAD_PENDING_TTL_MS - 60 * 60_000
/** Unclaimed uploads one visitor ip may hold per form in the last hour. */
export const FORM_UPLOAD_PENDING_PER_IP = 20
/** Unclaimed uploads one form may hold in total (a storage sink cap). */
export const FORM_UPLOAD_PENDING_PER_FORM = 500
export const FORM_UPLOAD_FILE_NAME_MAX = 200

export type StoreFormUploadResult =
  | { kind: "ok"; uploadId: string; fileName: string; sizeBytes: number }
  | { kind: "invalid"; code: "field" | "uploadType" | "uploadSize" }
  | { kind: "rateLimited" }

export type FormUploadRef = { fieldKey: string; uploadId: string }

const PATH_SEPARATORS = /[/\\]/
const UNSAFE_NAME_CHARS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069"]/g

/**
 * A display name only (the stored key never uses it): no path, no control
 * or bidi characters, capped; an empty result becomes `upload.<ext>`.
 */
export function sanitizeUploadFileName(
  raw: unknown,
  extension: string,
): string {
  const base =
    typeof raw === "string"
      ? (raw.split(PATH_SEPARATORS).pop() ?? "")
          .replace(UNSAFE_NAME_CHARS, "")
          .trim()
          .slice(0, FORM_UPLOAD_FILE_NAME_MAX)
      : ""
  return base.length > 0 && base !== "." && base !== ".."
    ? base
    : `upload.${extension}`
}

/** The upload field `key` of a published definition, or null. */
export function formUploadField(
  def: FormDefinition,
  key: unknown,
): FormField | null {
  if (typeof key !== "string") {
    return null
  }
  return (
    formInputFields(def).find(
      (f) => f.key === key && FORM_UPLOAD_FIELD_TYPES.has(f.type),
    ) ?? null
  )
}

/** The `fu_` ids a submission's values hold for the definition's upload fields. */
export function formUploadRefs(
  def: FormDefinition,
  values: Record<string, unknown>,
): FormUploadRef[] {
  const refs: FormUploadRef[] = []
  for (const field of formInputFields(def)) {
    const value = values[field.key]
    if (
      FORM_UPLOAD_FIELD_TYPES.has(field.type) &&
      typeof value === "string" &&
      FORM_UPLOAD_ID_REGEX.test(value)
    ) {
      refs.push({ fieldKey: field.key, uploadId: value })
    }
  }
  return refs
}

const newUploadId = () => `fu_${randomBytes(32).toString("base64url")}`

export class FormUploadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FormUploadError"
  }
}

export class FormUploadService {
  /**
   * Store one upload for `fieldKey` of a published web form. `bytes` is
   * already capped at the hard limit by the route; the field's own limit,
   * the sniffed type and the pending caps are checked here. The pending
   * caps are counted under a per-form lock, so parallel uploads cannot all
   * pass the same count.
   */
  async store(input: {
    form: NormalizedForm
    fieldKey: unknown
    interactionId: string
    clientIp: string
    bytes: Uint8Array
    fileName: unknown
    now?: Date
  }): Promise<StoreFormUploadResult> {
    const now = input.now ?? new Date()
    const { form } = input
    const field = formUploadField(
      form.publishedDefinition ?? EMPTY_FORM_DEFINITION,
      input.fieldKey,
    )
    if (field === null) {
      return { kind: "invalid", code: "field" }
    }
    if (input.bytes.byteLength > formUploadMaxBytes(field)) {
      return { kind: "invalid", code: "uploadSize" }
    }
    const sniffed = sniffUpload(input.bytes)
    if (
      sniffed === null ||
      !(formUploadMimeTypes(field.type) as readonly string[]).includes(
        sniffed.mimeType,
      )
    ) {
      return { kind: "invalid", code: "uploadType" }
    }

    const ipHash = hashClientIp(form.workspaceId, input.clientIp)
    const uploadId = newUploadId()
    const path = `${formUploadsPrefix(form.workspaceId, form.id)}${randomUUID()}`
    const fileName = sanitizeUploadFileName(input.fileName, sniffed.extension)
    const admitted = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`form-upload:${form.id}`}, 0))`,
      )
      const pending = and(
        eq(formUploadModel.formId, form.id),
        isNull(formUploadModel.submissionId),
      )
      const [perIp] = await tx
        .select({ n: count() })
        .from(formUploadModel)
        .where(
          and(
            pending,
            eq(formUploadModel.ipHash, ipHash),
            gt(
              formUploadModel.createdAt,
              new Date(now.getTime() - 60 * 60_000),
            ),
          ),
        )
      if ((perIp?.n ?? 0) >= FORM_UPLOAD_PENDING_PER_IP) {
        return false
      }
      const [perForm] = await tx
        .select({ n: count() })
        .from(formUploadModel)
        .where(pending)
      if ((perForm?.n ?? 0) >= FORM_UPLOAD_PENDING_PER_FORM) {
        return false
      }
      await tx.insert(formUploadModel).values({
        id: createId(),
        uploadId,
        workspaceId: form.workspaceId,
        formId: form.id,
        fieldKey: field.key,
        interactionId: input.interactionId,
        path,
        mimeType: sniffed.mimeType,
        sizeBytes: input.bytes.byteLength,
        fileName,
        ipHash,
        createdAt: now,
      })
      return true
    })
    if (!admitted) {
      return { kind: "rateLimited" }
    }

    // Row first, object second: a crash in between leaves a row the sweep
    // deletes (with a no-op object delete), never an object nothing names.
    try {
      await uploader.putObject(path, input.bytes, {
        ContentType: sniffed.mimeType,
      })
    } catch (error) {
      await db
        .delete(formUploadModel)
        .where(eq(formUploadModel.uploadId, uploadId))
        .catch((err) =>
          logger.warn(
            { err, formId: form.id, uploadId },
            "form upload: row cleanup after a failed put failed (the sweep takes it)",
          ),
        )
      throw error
    }
    return {
      kind: "ok",
      uploadId,
      fileName,
      sizeBytes: input.bytes.byteLength,
    }
  }

  /**
   * True when every ref names an unclaimed, unexpired upload of this form,
   * for its field, sent by this page load. A read before the submit writes
   * anything (no contact is created for a submit that will be refused);
   * `claim` is the authoritative check.
   */
  async claimable(input: {
    formId: string
    interactionId: string | undefined
    refs: FormUploadRef[]
    now: Date
    tx?: DatabaseClient
  }): Promise<boolean> {
    if (input.refs.length === 0) {
      return true
    }
    if (input.interactionId === undefined) {
      return false
    }
    const rows = await (input.tx ?? db)
      .select({
        uploadId: formUploadModel.uploadId,
        fieldKey: formUploadModel.fieldKey,
      })
      .from(formUploadModel)
      .where(
        this.claimableWhere({ ...input, interactionId: input.interactionId }),
      )
    return this.matches(rows, input.refs)
  }

  /**
   * Attach the refs to `submissionId` inside the submit's transaction. One
   * conditional UPDATE: a row another submission claimed first, the sweep
   * deleted, or that belongs to another field / page load is not updated,
   * and a short count means the caller must roll back.
   */
  async claim(
    tx: DatabaseClient,
    input: {
      formId: string
      submissionId: string
      interactionId: string | undefined
      refs: FormUploadRef[]
      now: Date
    },
  ): Promise<boolean> {
    if (input.refs.length === 0) {
      return true
    }
    if (input.interactionId === undefined) {
      return false
    }
    const rows = await tx
      .update(formUploadModel)
      .set({ submissionId: input.submissionId, updatedAt: input.now })
      .where(
        this.claimableWhere({ ...input, interactionId: input.interactionId }),
      )
      .returning({
        uploadId: formUploadModel.uploadId,
        fieldKey: formUploadModel.fieldKey,
      })
    return this.matches(rows, input.refs)
  }

  private claimableWhere(input: {
    formId: string
    interactionId: string
    refs: FormUploadRef[]
    now: Date
  }) {
    return and(
      eq(formUploadModel.formId, input.formId),
      eq(formUploadModel.interactionId, input.interactionId),
      inArray(
        formUploadModel.uploadId,
        input.refs.map((r) => r.uploadId),
      ),
      isNull(formUploadModel.submissionId),
      gt(
        formUploadModel.createdAt,
        new Date(input.now.getTime() - FORM_UPLOAD_CLAIM_TTL_MS),
      ),
    )
  }

  /** Every ref found exactly once, on its own field (a repeated id fails). */
  private matches(
    rows: { uploadId: string; fieldKey: string }[],
    refs: FormUploadRef[],
  ): boolean {
    if (new Set(refs.map((r) => r.uploadId)).size !== refs.length) {
      return false
    }
    const byId = new Map(rows.map((r) => [r.uploadId, r.fieldKey]))
    return (
      rows.length === refs.length &&
      refs.every((r) => byId.get(r.uploadId) === r.fieldKey)
    )
  }

  /** One claimed upload of a form, for the member-authed download route. */
  async findClaimed(input: {
    workspaceId: string
    formId: string
    uploadId: string
  }): Promise<FormUploadModel | null> {
    if (!FORM_UPLOAD_ID_REGEX.test(input.uploadId)) {
      return null
    }
    const [row] = await db
      .select()
      .from(formUploadModel)
      .where(
        and(
          eq(formUploadModel.workspaceId, input.workspaceId),
          eq(formUploadModel.formId, input.formId),
          eq(formUploadModel.uploadId, input.uploadId),
        ),
      )
      .limit(1)
    return row && row.submissionId !== null ? row : null
  }

  /**
   * The object keys of one submission's uploads, read BEFORE its row is
   * deleted (the rows cascade away with it); the caller removes the objects
   * after its delete commits.
   */
  async pathsOfSubmission(
    submissionId: string,
    tx: DatabaseClient = db,
  ): Promise<string[]> {
    const rows = await tx
      .select({ path: formUploadModel.path })
      .from(formUploadModel)
      .where(eq(formUploadModel.submissionId, submissionId))
    return rows.map((r) => r.path)
  }

  /** Best-effort object removal after a committed row delete. */
  async removeObjects(
    paths: string[],
    context: Record<string, unknown>,
  ): Promise<void> {
    if (paths.length === 0) {
      return
    }
    try {
      const { deleted, firstFailure } = await uploader.deleteObjects(paths)
      if (deleted < paths.length) {
        logger.warn(
          { ...context, deleted, total: paths.length, err: firstFailure },
          "form upload: some objects were not deleted",
        )
      }
    } catch (err) {
      logger.warn({ ...context, err }, "form upload: object delete failed")
    }
  }

  /**
   * Delete up to `limit` uploads no submission claimed within the TTL: lock
   * the rows (SKIP LOCKED: a submit claiming one keeps it), delete their
   * objects, then the rows, in one transaction. A failed object delete keeps
   * every row of the batch for the next pass; the store confirms per key, so
   * a retried key that is already gone is not an error.
   */
  async sweepExpired(input: { limit: number; now?: Date }): Promise<number> {
    const now = input.now ?? new Date()
    return await db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: formUploadModel.id, path: formUploadModel.path })
        .from(formUploadModel)
        .where(
          and(
            isNull(formUploadModel.submissionId),
            lt(
              formUploadModel.createdAt,
              new Date(now.getTime() - FORM_UPLOAD_PENDING_TTL_MS),
            ),
          ),
        )
        .orderBy(formUploadModel.createdAt)
        .limit(input.limit)
        .for("update", { skipLocked: true })
      if (rows.length === 0) {
        return 0
      }
      const { deleted, firstFailure } = await uploader.deleteObjects(
        rows.map((r) => r.path),
      )
      if (deleted < rows.length) {
        throw new FormUploadError(
          `form upload sweep: ${rows.length - deleted} of ${rows.length} objects not deleted (${String(firstFailure)})`,
        )
      }
      await tx.delete(formUploadModel).where(
        inArray(
          formUploadModel.id,
          rows.map((r) => r.id),
        ),
      )
      return rows.length
    })
  }
}

export const formUploadService = new FormUploadService()
