import { randomBytes, randomUUID } from "node:crypto"
import {
  and,
  count,
  type DatabaseClient,
  db,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
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
 * A submit claims only uploads younger than this, an hour short of the
 * sweep's age. Safety does not rest on the margin: the sweep's committed
 * `deletingAt` mark is what a claim refuses.
 */
export const FORM_UPLOAD_CLAIM_TTL_MS = FORM_UPLOAD_PENDING_TTL_MS - 60 * 60_000
/** A marked row whose object delete failed is retried after this long. */
export const FORM_UPLOAD_RETRY_BACKOFF_MS = 60 * 60_000
/** Unclaimed uploads one visitor ip may hold per form in the last hour. */
export const FORM_UPLOAD_PENDING_PER_IP = 20
/** Unclaimed uploads one form may hold in total (a storage sink cap). */
export const FORM_UPLOAD_PENDING_PER_FORM = 500
export const FORM_UPLOAD_FILE_NAME_MAX = 200

export type StoreFormUploadResult =
  | { kind: "ok"; uploadId: string; fileName: string; sizeBytes: number }
  | { kind: "invalid"; code: "field" | "uploadType" | "uploadSize" }
  | { kind: "rateLimited" }
  /** The form was deleted while the object was being written. */
  | { kind: "gone" }

export type FormUploadRef = { fieldKey: string; uploadId: string }
type CleanupRow = { id: string; path: string }

/** At most `max` code points: never splits a surrogate pair. */
const truncateCodePoints = (value: string, max: number): string =>
  Array.from(value).slice(0, max).join("")

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
      ? truncateCodePoints(
          (raw.split(PATH_SEPARATORS).pop() ?? "")
            .replace(UNSAFE_NAME_CHARS, "")
            .trim(),
          FORM_UPLOAD_FILE_NAME_MAX,
        )
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

export class FormUploadService {
  /**
   * Store one upload for `fieldKey` of a published web form. `bytes` is
   * already capped at the hard limit by the route; the field's own limit,
   * the sniffed type and the pending caps are checked here. The pending
   * caps are counted under a per-form lock, so parallel uploads cannot all
   * pass the same count. Every age is the DATABASE clock (`now()`), so app
   * processes with skewed clocks agree (Codex probe s225a).
   */
  async store(input: {
    form: NormalizedForm
    fieldKey: unknown
    interactionId: string
    clientIp: string
    bytes: Uint8Array
    fileName: unknown
  }): Promise<StoreFormUploadResult> {
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
            sql`${formUploadModel.createdAt} > now() - interval '1 hour'`,
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
      })
      return true
    })
    if (!admitted) {
      return { kind: "rateLimited" }
    }

    // Row first, object second, and a failed put KEEPS the row: a rejected
    // PUT does not prove the store did not commit it (Codex probe s225a), so
    // the row stays counted against the pending caps and the sweep deletes
    // the object (a no-op if absent) with it. Its id never reached the
    // caller, so nothing can claim it.
    await uploader.putObject(path, input.bytes, {
      ContentType: sniffed.mimeType,
    })
    // A form (or workspace) delete that committed while the object was in
    // flight took the row and purged the prefix BEFORE this object landed:
    // nothing would ever name it, so remove it here (Codex probe s225a).
    const [still] = await db
      .select({ id: formUploadModel.id })
      .from(formUploadModel)
      .where(eq(formUploadModel.uploadId, uploadId))
      .limit(1)
    if (!still) {
      await this.deleteObject(path, { formId: form.id })
      return { kind: "gone" }
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
  }): Promise<boolean> {
    if (input.refs.length === 0) {
      return true
    }
    if (input.interactionId === undefined) {
      return false
    }
    const rows = await db
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
   * marked for deletion, or that belongs to another field / page load is
   * not updated, and a short count means the caller must roll back. A row
   * the sweep is marking is locked by it; this UPDATE waits and re-checks
   * `deletingAt`, so a claim never lands on an object being deleted.
   */
  async claim(
    tx: DatabaseClient,
    input: {
      formId: string
      submissionId: string
      interactionId: string | undefined
      refs: FormUploadRef[]
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
      .set({ submissionId: input.submissionId, updatedAt: sql`now()` })
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
  }) {
    return and(
      eq(formUploadModel.formId, input.formId),
      eq(formUploadModel.interactionId, input.interactionId),
      inArray(
        formUploadModel.uploadId,
        input.refs.map((r) => r.uploadId),
      ),
      isNull(formUploadModel.submissionId),
      isNull(formUploadModel.deletingAt),
      sql`${formUploadModel.createdAt} > now() - ${`${FORM_UPLOAD_CLAIM_TTL_MS} milliseconds`}::interval`,
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
   * Inside a submission delete's transaction: detach its uploads and mark
   * them for deletion (eligible at once), so they outlive the submission row
   * as durable cleanup records instead of cascading away with it (Codex
   * probe s225a). Returns them for an immediate best-effort `retire`; the
   * sweep retries whatever that leaves.
   */
  async detachForDeletion(
    tx: DatabaseClient,
    scope: { workspaceId: string; formId: string; submissionId: string },
  ): Promise<CleanupRow[]> {
    return await tx
      .update(formUploadModel)
      .set({
        submissionId: null,
        deletingAt: sql`now() - ${`${FORM_UPLOAD_RETRY_BACKOFF_MS} milliseconds`}::interval`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(formUploadModel.workspaceId, scope.workspaceId),
          eq(formUploadModel.formId, scope.formId),
          eq(formUploadModel.submissionId, scope.submissionId),
        ),
      )
      .returning({ id: formUploadModel.id, path: formUploadModel.path })
  }

  /**
   * Delete each marked row's object, then the rows whose delete the store
   * confirmed. One key at a time, so a key that keeps failing holds back only
   * its own row (it stays marked and is retried after the backoff), never
   * the batch. Returns how many rows went.
   */
  async retire(
    rows: CleanupRow[],
    context: Record<string, unknown>,
  ): Promise<number> {
    const done: string[] = []
    for (const row of rows) {
      if (await this.deleteObject(row.path, context)) {
        done.push(row.id)
      }
    }
    if (done.length > 0) {
      await db
        .delete(formUploadModel)
        .where(
          and(
            inArray(formUploadModel.id, done),
            isNull(formUploadModel.submissionId),
            isNotNull(formUploadModel.deletingAt),
          ),
        )
    }
    return done.length
  }

  private async deleteObject(
    path: string,
    context: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      await uploader.deleteObject(path)
      return true
    } catch (err) {
      logger.warn(
        { ...context, path, err },
        "form upload: object delete failed",
      )
      return false
    }
  }

  /**
   * One sweep batch. First MARK (and commit) up to `limit` rows: unclaimed
   * uploads past their TTL, plus marked rows whose last attempt is older
   * than the backoff, oldest first (SKIP LOCKED: a submit holding a row
   * keeps it). Then `retire` them outside the transaction. The mark is what
   * makes a claim impossible before any object is touched, so a crash or a
   * failed delete can never leave a claimable row without its object.
   */
  async sweepExpired(input: { limit: number }): Promise<{
    marked: number
    deleted: number
  }> {
    const rows = await db.transaction(async (tx) => {
      const due = await tx
        .select({ id: formUploadModel.id })
        .from(formUploadModel)
        .where(
          and(
            isNull(formUploadModel.submissionId),
            or(
              and(
                isNull(formUploadModel.deletingAt),
                sql`${formUploadModel.createdAt} < now() - ${`${FORM_UPLOAD_PENDING_TTL_MS} milliseconds`}::interval`,
              ),
              sql`${formUploadModel.deletingAt} < now() - ${`${FORM_UPLOAD_RETRY_BACKOFF_MS} milliseconds`}::interval`,
            ),
          ),
        )
        .orderBy(
          sql`coalesce(${formUploadModel.deletingAt}, ${formUploadModel.createdAt})`,
        )
        .limit(input.limit)
        .for("update", { skipLocked: true })
      if (due.length === 0) {
        return []
      }
      return await tx
        .update(formUploadModel)
        .set({ deletingAt: sql`now()`, updatedAt: sql`now()` })
        .where(
          inArray(
            formUploadModel.id,
            due.map((r) => r.id),
          ),
        )
        .returning({ id: formUploadModel.id, path: formUploadModel.path })
    })
    const deleted = await this.retire(rows, { job: "form-upload-sweep" })
    return { marked: rows.length, deleted }
  }
}

export const formUploadService = new FormUploadService()
