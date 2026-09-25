import { createHash, timingSafeEqual } from "node:crypto"
import {
  and,
  type DatabaseClient,
  db,
  eq,
  isNull,
  ne,
} from "@chatbotx.io/database/client"
import { contactDocumentModel } from "@chatbotx.io/database/schema"
import type { ContactDocumentModel } from "@chatbotx.io/database/types"
import { uploader } from "@chatbotx.io/filesystem"
import { tagService } from "../tag/service"
import {
  createDocumensoClient,
  type DocumensoClient,
  documensoConfigFromEnv,
} from "./documenso"
import { isJsonObject, type JsonObject } from "./gotenberg"
import { documentsEnv } from "./keys"
import { contactDocumentPath } from "./paths"
import { documentService, type ResolveDocumentVariables } from "./service"

/**
 * Signing a contact document with Documenso (roadmap B6, hub-native; the
 * bulktext s196c/s197c daemon path, ported). A flow step renders the template
 * for the contact (idempotent per ref), opens a Documenso envelope from that
 * PDF with externalId `cbxdoc:<ContactDocument.id>`, checks it carries a
 * SIGNATURE field for the signer, distributes it without email and returns
 * the signing link for the flow to text. The Documenso webhook then confirms
 * completion WITH Documenso (the webhook's only proof is a shared secret),
 * stores the signed PDF and tags the contact `doc-signed`, which wakes a
 * parked `waitForEvent`.
 */
export const DOCUMENT_SIGNED_TAG = "doc-signed"
export const SIG_LINK_FIELD = "sig_link"
export const SIG_DOC_ID_FIELD = "sig_doc_id"
const COMPLETED_EVENT = "DOCUMENT_COMPLETED"
// A ContactDocument id is a Postgres bigint; Documenso's document id an int4.
const EXTERNAL_ID_REGEX = /^cbxdoc:([1-9][0-9]{0,18})$/
const MAX_BIGINT = BigInt("9223372036854775807")
const SECONDARY_ID_REGEX = /^document_([1-9][0-9]{0,9})$/
const MAX_INT4 = 2_147_483_647
// Whitespace or control characters in a link we text: refuse, never repair.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const UNSAFE_URL_CHARS_REGEX = /[\s\u0000-\u001f\u007f]/
const MAX_ERROR = 300
const PDF_SUFFIX_REGEX = /\.pdf$/

export const contactDocumentExternalId = (id: string) => `cbxdoc:${id}`
export const signedDocumentPath = (
  workspaceId: string,
  contactId: string,
  documentId: string,
) =>
  contactDocumentPath(workspaceId, contactId, documentId).replace(
    PDF_SUFFIX_REGEX,
    ".signed.pdf",
  )

export type SignFailureStage =
  | "config"
  | "render"
  | "create"
  | "verify"
  | "distribute"

export type SignResult =
  | {
      ok: true
      reused: boolean
      document: ContactDocumentModel
      signingUrl: string
      documensoDocumentId: number
    }
  | { ok: false; stage: SignFailureStage; error: string }

/**
 * The envelope must be ours and signable: DRAFT/PENDING, our externalId, a
 * numeric secondaryId, and a SIGNATURE field for our signer. A string is the
 * reason it is not.
 */
export const verifySignableEnvelope = (
  env: JsonObject,
  externalId: string,
  email: string,
): { documentId: number } | string => {
  if (env.status !== "DRAFT" && env.status !== "PENDING") {
    return `status ${String(env.status).slice(0, 20)}`
  }
  if (env.externalId !== externalId) {
    return "externalId mismatch"
  }
  const m = SECONDARY_ID_REGEX.exec(String(env.secondaryId ?? ""))
  if (m === null || Number(m[1]) > MAX_INT4) {
    return "no secondaryId"
  }
  const recipients = Array.isArray(env.recipients) ? env.recipients : []
  const signer = recipients.find(
    (r): r is JsonObject => isJsonObject(r) && r.email === email,
  )
  // An integer id, or `undefined === undefined` would match an id-less field.
  if (!(signer && Number.isSafeInteger(signer.id))) {
    return "signer missing"
  }
  const fields = Array.isArray(env.fields) ? env.fields : []
  const hasSignature = fields.some(
    (f) =>
      isJsonObject(f) && f.type === "SIGNATURE" && f.recipientId === signer.id,
  )
  if (!hasSignature) {
    return "no signature field (add the signature block to the template)"
  }
  return { documentId: Number(m[1]) }
}

/** The normalised https URL, or null; a raw value with whitespace is refused. */
const httpsUrlOrNull = (value: unknown): string | null => {
  if (typeof value !== "string" || UNSAFE_URL_CHARS_REGEX.test(value)) {
    return null
  }
  try {
    const url = new URL(value)
    return url.protocol === "https:" ? url.href : null
  } catch {
    return null
  }
}

export type DocumensoWebhookOutcome =
  | "ignored"
  | "unknown"
  | "unconfirmed"
  | "duplicate"
  | "signed"
  | "retry"

export class DocumentSigningService {
  private client(injected?: DocumensoClient): DocumensoClient | null {
    if (injected) {
      return injected
    }
    const config = documensoConfigFromEnv()
    return config ? createDocumensoClient(config) : null
  }

  /**
   * Render (or reuse by `ref`) and send one document for signature. Never
   * throws for an upstream failure: `{ ok: false, stage, error }`, and the
   * reason is kept on the row (`error`). A retry with the same ref resumes:
   * a sent row answers its stored link, an envelope already created is
   * re-verified and re-distributed (idempotent on a PENDING envelope).
   */
  async sendForSignature(props: {
    workspaceId: string
    contactId: string
    templateId: string
    ref: string
    signerName: string
    resolveVariables: ResolveDocumentVariables
    documenso?: DocumensoClient
    signerDomain?: string
    tx?: DatabaseClient
  }): Promise<SignResult> {
    const { workspaceId, contactId, tx = db } = props
    const documenso = this.client(props.documenso)
    const signerDomain =
      props.signerDomain ?? documentsEnv().DOCUMENSO_SIGNER_DOMAIN
    if (!(documenso && signerDomain)) {
      return { ok: false, stage: "config", error: "not-configured" }
    }

    let row: ContactDocumentModel
    try {
      ;({ document: row } = await documentService.generateForContact({
        workspaceId,
        contactId,
        templateId: props.templateId,
        ref: props.ref,
        resolveVariables: props.resolveVariables,
        tx,
      }))
    } catch (err) {
      return {
        ok: false,
        stage: "render",
        error: err instanceof Error ? err.message : "render failed",
      }
    }
    if (
      (row.status === "sent" || row.status === "signed") &&
      row.signingUrl &&
      row.documensoDocumentId !== null
    ) {
      return {
        ok: true,
        reused: true,
        document: row,
        signingUrl: row.signingUrl,
        documensoDocumentId: row.documensoDocumentId,
      }
    }

    const fail = async (
      stage: SignFailureStage,
      error: string,
    ): Promise<SignResult> => {
      await tx
        .update(contactDocumentModel)
        .set({
          error: `${stage}: ${error}`.slice(0, MAX_ERROR),
          updatedAt: new Date(),
        })
        .where(eq(contactDocumentModel.id, row.id))
      return { ok: false, stage, error }
    }

    const externalId = contactDocumentExternalId(row.id)
    const email = `sig+${contactId}@${signerDomain}`
    let envelopeId = row.documensoEnvelopeId
    if (envelopeId === null) {
      if (!row.path) {
        return fail("render", "the document has no stored PDF")
      }
      let pdf: Uint8Array
      try {
        pdf = await uploader.getObject(row.path)
      } catch {
        return fail("render", "could not read the stored PDF")
      }
      const created = await documenso.createEnvelope({
        pdf,
        title: row.title,
        externalId,
        recipient: { email, name: props.signerName },
      })
      if (!created.ok) {
        return fail("create", created.error)
      }
      // First envelope wins: a concurrent retry that also created one leaves
      // an orphan DRAFT that is never distributed, so nobody gets its link.
      const [claimed] = await tx
        .update(contactDocumentModel)
        .set({ documensoEnvelopeId: created.envelopeId, updatedAt: new Date() })
        .where(
          and(
            eq(contactDocumentModel.id, row.id),
            isNull(contactDocumentModel.documensoEnvelopeId),
          ),
        )
        .returning({ envelopeId: contactDocumentModel.documensoEnvelopeId })
      if (claimed?.envelopeId) {
        envelopeId = claimed.envelopeId
      } else {
        // Lost to a concurrent retry: drop ours so no untracked copy of the
        // contact's document stays in Documenso (best effort).
        await documenso.deleteEnvelope(created.envelopeId)
        const [current] = await tx
          .select({ envelopeId: contactDocumentModel.documensoEnvelopeId })
          .from(contactDocumentModel)
          .where(eq(contactDocumentModel.id, row.id))
          .limit(1)
        envelopeId = current?.envelopeId ?? null
        if (envelopeId === null) {
          return fail("create", "envelope claim lost")
        }
      }
    }

    const got = await documenso.getEnvelope(envelopeId)
    if (!got.ok) {
      return fail("verify", got.error)
    }
    const checked = verifySignableEnvelope(got.body, externalId, email)
    if (typeof checked === "string") {
      // A COMPLETED envelope is signed already: keep it, the webhook owns it.
      if (got.body.status === "COMPLETED") {
        return fail("verify", checked)
      }
      // Documenso answered and the envelope can never be signed as-is: forget
      // (and drop) it, so a retry opens a fresh one instead of re-verifying it
      // forever.
      await documenso.deleteEnvelope(envelopeId)
      await tx
        .update(contactDocumentModel)
        .set({ documensoEnvelopeId: null, updatedAt: new Date() })
        .where(
          and(
            eq(contactDocumentModel.id, row.id),
            eq(contactDocumentModel.documensoEnvelopeId, envelopeId),
          ),
        )
      return fail("verify", checked)
    }

    const dist = await documenso.distributeEnvelope(envelopeId)
    if (!dist.ok) {
      return fail("distribute", dist.error)
    }
    const recipients = Array.isArray(dist.body.recipients)
      ? dist.body.recipients
      : []
    const signer = recipients.find(
      (r): r is JsonObject => isJsonObject(r) && r.email === email,
    )
    const signingUrl = httpsUrlOrNull(signer?.signingUrl)
    if (signingUrl === null) {
      return fail("distribute", "no https signingUrl for the signer")
    }
    const [sent] = await tx
      .update(contactDocumentModel)
      .set({
        status: "sent",
        signingUrl,
        documensoDocumentId: checked.documentId,
        error: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(contactDocumentModel.id, row.id),
          ne(contactDocumentModel.status, "signed"),
        ),
      )
      .returning()
    return {
      ok: true,
      reused: false,
      document: sent ?? row,
      signingUrl,
      documensoDocumentId: checked.documentId,
    }
  }

  /**
   * A Documenso webhook body, already authenticated by its secret header.
   * Only DOCUMENT_COMPLETED on one of OUR documents signs anything, and only
   * after Documenso itself confirms it: a leaked secret must not be enough to
   * mark a contact signed. `retry` = a transient failure (the route answers
   * 503 so Documenso redelivers); every other outcome is final (200).
   */
  async completeFromWebhook(props: {
    body: unknown
    documenso?: DocumensoClient
    now?: Date
    tx?: DatabaseClient
  }): Promise<{ outcome: DocumensoWebhookOutcome; detail: string }> {
    const { body, tx = db } = props
    if (!isJsonObject(body) || typeof body.event !== "string") {
      return { outcome: "ignored", detail: "not a Documenso event" }
    }
    if (body.event !== COMPLETED_EVENT) {
      return { outcome: "ignored", detail: body.event.slice(0, 64) }
    }
    const payload = isJsonObject(body.payload) ? body.payload : null
    const match =
      payload && typeof payload.externalId === "string"
        ? EXTERNAL_ID_REGEX.exec(payload.externalId)
        : null
    if (!(payload && match) || BigInt(match[1]) > MAX_BIGINT) {
      return { outcome: "unknown", detail: "not a hub document" }
    }
    const [row] = await tx
      .select()
      .from(contactDocumentModel)
      .where(eq(contactDocumentModel.id, match[1]))
      .limit(1)
    if (!row) {
      return { outcome: "unknown", detail: `no document ${match[1]}` }
    }
    if (row.status === "signed") {
      return { outcome: "duplicate", detail: `document ${row.id}` }
    }
    // The envelope GET below is the authority; a numeric payload id that
    // names another Documenso document is refused before asking.
    if (
      row.documensoEnvelopeId === null ||
      (Number.isSafeInteger(payload.id) &&
        row.documensoDocumentId !== null &&
        row.documensoDocumentId !== payload.id)
    ) {
      return {
        outcome: "unconfirmed",
        detail: `document ${row.id} was not sent as this Documenso document`,
      }
    }
    const documenso = this.client(props.documenso)
    if (!documenso) {
      return { outcome: "retry", detail: "not-configured" }
    }

    const got = await documenso.getEnvelope(row.documensoEnvelopeId)
    if (!got.ok) {
      return got.status === 404
        ? { outcome: "unconfirmed", detail: "envelope not found" }
        : { outcome: "retry", detail: `confirm: ${got.error}` }
    }
    const env = got.body
    if (env.externalId !== contactDocumentExternalId(row.id)) {
      return { outcome: "unconfirmed", detail: "externalId mismatch" }
    }
    // Still PENDING right after the event: Documenso may not have committed
    // the completion yet, so let it redeliver (its retries are bounded).
    if (env.status === "PENDING") {
      return { outcome: "retry", detail: "Documenso still has status PENDING" }
    }
    if (env.status !== "COMPLETED") {
      return {
        outcome: "unconfirmed",
        detail: `Documenso has status ${String(env.status).slice(0, 20)}`,
      }
    }
    const items = Array.isArray(env.envelopeItems) ? env.envelopeItems : []
    const itemId = isJsonObject(items[0]) ? items[0].id : undefined
    if (typeof itemId !== "string") {
      return { outcome: "retry", detail: "envelope has no item" }
    }
    const signed = await documenso.downloadSignedItem(itemId)
    if (!signed.ok) {
      return { outcome: "retry", detail: `download: ${signed.error}` }
    }
    // Deterministic key: two concurrent deliveries write the same bytes to
    // the same object, so the loser never deletes the winner's file.
    const signedPath = signedDocumentPath(
      row.workspaceId,
      row.contactId,
      row.id,
    )
    try {
      await uploader.putObject(signedPath, Buffer.from(signed.pdf), {
        ContentType: "application/pdf",
      })
    } catch {
      return { outcome: "retry", detail: "could not store the signed PDF" }
    }

    const signedAt = props.now ?? new Date()
    const [claimed] = await tx
      .update(contactDocumentModel)
      .set({ status: "signed", signedPath, signedAt, updatedAt: signedAt })
      .where(
        and(
          eq(contactDocumentModel.id, row.id),
          ne(contactDocumentModel.status, "signed"),
        ),
      )
      .returning({ id: contactDocumentModel.id })
    if (!claimed) {
      return { outcome: "duplicate", detail: `document ${row.id}` }
    }
    try {
      // "all": a contact signing a SECOND document already carries the tag,
      // and its parked wait must still hear tagApplied. The row claim above
      // makes this once per document.
      await tagService.attachByNamesToContacts({
        workspaceId: row.workspaceId,
        contactIds: [row.contactId],
        names: [DOCUMENT_SIGNED_TAG],
        emitFor: "all",
      })
    } catch (err) {
      // Undo the claim so Documenso's redelivery tags the contact.
      await tx
        .update(contactDocumentModel)
        .set({
          status: "sent",
          signedPath: null,
          signedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(contactDocumentModel.id, row.id),
            eq(contactDocumentModel.signedAt, signedAt),
          ),
        )
      return {
        outcome: "retry",
        detail: `tag: ${err instanceof Error ? err.message : "failed"}`.slice(
          0,
          MAX_ERROR,
        ),
      }
    }
    return { outcome: "signed", detail: `document ${row.id}` }
  }
}

/**
 * Constant-time check of the `X-Documenso-Secret` header. `not-configured`
 * when the hub has no secret (the route refuses: fail closed).
 */
export const verifyDocumensoSecret = (
  header: string | null,
  secret: string | undefined = documentsEnv().DOCUMENSO_WEBHOOK_SECRET,
): "ok" | "not-configured" | "invalid" => {
  if (!secret) {
    return "not-configured"
  }
  if (!header) {
    return "invalid"
  }
  const digest = (v: string) => createHash("sha256").update(v).digest()
  return timingSafeEqual(digest(header), digest(secret)) ? "ok" : "invalid"
}

export const documentSigningService = new DocumentSigningService()
