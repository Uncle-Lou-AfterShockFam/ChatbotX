import { mediaLibraryService, signEmailClickUrl } from "@chatbotx.io/business"
import { emailTemplateService } from "@chatbotx.io/business/email-templates"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import type { InboxWithIntegrations } from "@chatbotx.io/database/types"
import {
  collectRenderInputs,
  DocumentTooLargeError,
  DocumentValidationError,
  type EmailDocument,
  type LeafBlock,
  leafBlocks,
  parseDocument,
  type RenderAsset,
} from "@chatbotx.io/email-document"
import { renderEmail } from "@chatbotx.io/email-document/render-email"
import { uploader } from "@chatbotx.io/filesystem"
import {
  type EmailStepSchema,
  openWebsiteStepSchema,
  type PageElementSchema,
  startAnotherNodeStepSchema,
  startExternalFlowStepSchema,
  startExternalNodeStepSchema,
} from "@chatbotx.io/flow-config"
import { isWorkspaceStorageKey } from "@chatbotx.io/utils"
import { contactVariableService } from "@chatbotx.io/variables"
import { resolveButtonUrl } from "../../lib/convert-button"
import { logger } from "../../lib/logger"

/** Image files looked up per send; attachments are counted separately. */
const MAX_IMAGE_ASSETS = 50
/** Distinct files attached to one email. */
export const MAX_ATTACHMENTS = 10
/** Total attachment bytes per email, measured on the stored object. */
export const MAX_ATTACHMENT_BYTES_TOTAL = 10 * 1024 * 1024
/** One deadline for reading every attachment of an email (then: retry). */
export const ATTACHMENT_READ_TIMEOUT_MS = 60_000
/** Template links signed per send (a link-dense document stays bounded). */
const MAX_LINKS = 100

/**
 * The step's CONTENT is unusable (template gone, invalid document): the send
 * is failed closed and not retried. Every other error propagates to the
 * queue's retry, exactly as the legacy path always did.
 */
export class EmailContentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "EmailContentError"
  }
}

/**
 * A document flow button's beforeStep, validated by the SAME flow-config
 * schema a legacy button uses, per its stepType; anything else is dropped.
 */
const BUTTON_STEPS = {
  openWebsite: openWebsiteStepSchema,
  startExternalFlow: startExternalFlowStepSchema,
  startExternalNode: startExternalNodeStepSchema,
  startAnotherNode: startAnotherNodeStepSchema,
} as const

type Variables = Awaited<ReturnType<typeof contactVariableService.getAll>>
type MediaFile = Awaited<ReturnType<typeof mediaLibraryService.findFile>>

/**
 * A nodemailer attachment, fully buffered so a re-invoked send can resend it.
 * `key` is its workspace storage key: the email line (s222b) is handed a
 * signed download of it instead of the bytes; SMTP never sees it.
 */
export type MailAttachment = {
  filename: string
  content: Buffer
  contentType: string
  key: string
}

const MIME_TYPE = /^[\w.+-]{1,64}\/[\w.+-]{1,64}$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g
const PATH_SEPARATOR = /[\\/]/
const MAX_FILENAME = 200

function isNotFound(error: unknown): boolean {
  return error instanceof ChatbotXException && error.httpStatusCode === 404
}

/** S3/RustFS: the row exists but its object is gone. */
function isMissingObject(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404
}

function tooLarge(): EmailContentError {
  return new EmailContentError(
    `the email's attachments exceed ${MAX_ATTACHMENT_BYTES_TOTAL} bytes`,
  )
}

/**
 * Reads each attachment from storage by KEY (never nodemailer's `path: url`,
 * an unpinned fetch), under ONE running byte budget: the advertised length
 * rejects early and the read itself is capped, because the media row's
 * `size` is client-supplied. The key is re-checked against the workspace's
 * own prefix (rows created before the segment check could climb out of it).
 * A bad key, a missing object or an over-budget total is unusable content;
 * the deadline and any other storage error propagate to the retry.
 */
export async function loadAttachments(
  workspaceId: string,
  files: MediaFile[],
): Promise<MailAttachment[]> {
  for (const file of files) {
    if (!isWorkspaceStorageKey(file.path, workspaceId)) {
      throw new EmailContentError(
        `attachment ${file.id} has a storage key outside the workspace`,
      )
    }
  }
  const signal = AbortSignal.timeout(ATTACHMENT_READ_TIMEOUT_MS)
  let total = 0
  const out: MailAttachment[] = []
  for (const file of files) {
    let object: Awaited<ReturnType<typeof uploader.getObjectStream>>
    try {
      object = await uploader.getObjectStream(file.path, {
        abortSignal: signal,
      })
    } catch (error) {
      if (isMissingObject(error)) {
        throw new EmailContentError(
          `attachment ${file.id} is missing from storage`,
          { cause: error },
        )
      }
      throw error
    }
    const { stream, contentLength } = object
    const abort = () => stream.destroy(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    try {
      if (
        contentLength !== undefined &&
        total + contentLength > MAX_ATTACHMENT_BYTES_TOTAL
      ) {
        throw tooLarge()
      }
      const chunks: Buffer[] = []
      for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        total += buf.length
        if (total > MAX_ATTACHMENT_BYTES_TOTAL) {
          throw tooLarge()
        }
        chunks.push(buf)
      }
      out.push({
        filename: attachmentName(file.name, file.id),
        content: Buffer.concat(chunks),
        contentType: MIME_TYPE.test(file.mimeType ?? "")
          ? file.mimeType
          : "application/octet-stream",
        key: file.path,
      })
    } finally {
      signal.removeEventListener("abort", abort)
      stream.destroy()
    }
  }
  return out
}

/** The stored name is client-supplied: no control chars or path parts. */
function attachmentName(name: string | null | undefined, id: string): string {
  const base =
    (name ?? "")
      .replace(CONTROL_CHARS, "")
      .split(PATH_SEPARATOR)
      .pop()
      ?.trim() ?? ""
  if (base.length <= MAX_FILENAME) {
    return base || `attachment-${id}`
  }
  // Keep a short extension so the recipient's client still opens it.
  const dot = base.lastIndexOf(".")
  const ext = dot > 0 && base.length - dot <= 10 ? base.slice(dot) : ""
  return base.slice(0, MAX_FILENAME - ext.length) + ext
}

async function loadDocument(
  step: EmailStepSchema,
  workspaceId: string,
): Promise<EmailDocument> {
  try {
    if (step.templateId) {
      return await emailTemplateService.getDocument({
        workspaceId,
        id: step.templateId,
      })
    }
    return parseDocument(step.document)
  } catch (error) {
    if (
      isNotFound(error) ||
      error instanceof DocumentValidationError ||
      error instanceof DocumentTooLargeError
    ) {
      throw new EmailContentError(
        step.templateId
          ? `email template ${step.templateId} is missing or invalid`
          : "the step's email document is invalid",
        { cause: error },
      )
    }
    throw error
  }
}

function legacyButton(
  leaf: Extract<LeafBlock, { type: "button" }>,
): Extract<PageElementSchema, { type: "button" }> | undefined {
  if (leaf.action.kind !== "flow") {
    return
  }
  const stepType = String(leaf.action.beforeStep.stepType ?? "")
  if (!Object.hasOwn(BUTTON_STEPS, stepType)) {
    return
  }
  const buttonType = stepType as keyof typeof BUTTON_STEPS
  const parsed = BUTTON_STEPS[buttonType].safeParse(leaf.action.beforeStep)
  if (!parsed.success) {
    return
  }
  return {
    id: leaf.id,
    type: "button",
    label: leaf.label,
    buttonType,
    beforeStep: parsed.data,
    steps: [],
  } as Extract<PageElementSchema, { type: "button" }>
}

/** Everything a document send needs that does NOT depend on the tracking token. */
export type PreparedDocument = {
  doc: EmailDocument
  inputs: ReturnType<typeof collectRenderInputs>
  vars: Record<string, string>
  assets: Record<string, RenderAsset>
  attachments: MailAttachment[]
}

/**
 * B2 phase 2b / 3a, part 1: every failure-prone READ of a document send --
 * the template, merge values, media rows and attachment bytes -- runs BEFORE
 * the caller writes its per-recipient tracking row. A transient error here
 * retries the step with nothing written, so a retry never double-counts a
 * send (skeptic s221b). Unusable content throws EmailContentError.
 */
export async function prepareStepDocument(props: {
  step: EmailStepSchema
  workspaceId: string
  variables: Variables
}): Promise<PreparedDocument> {
  const { step, workspaceId } = props
  const doc = await loadDocument(step, workspaceId)
  const inputs = collectRenderInputs(doc)

  const vars =
    inputs.tokenNames.length > 0
      ? await contactVariableService.resolveMapping({
          text: inputs.tokenNames.map((name) => `{{${name}}}`).join(" "),
          variables: props.variables,
        })
      : {}

  // Attachments are resolved in full (capped, fail closed); images up to
  // MAX_IMAGE_ASSETS, a deleted one rendering as `asset:<id>` in `missing`.
  const attachmentIds = [
    ...new Set(
      leafBlocks(doc).flatMap((leaf) =>
        leaf.type === "attachment" ? [leaf.asset.fileId] : [],
      ),
    ),
  ]
  if (attachmentIds.length > MAX_ATTACHMENTS) {
    throw new EmailContentError(
      `the email has ${attachmentIds.length} attachments (max ${MAX_ATTACHMENTS})`,
    )
  }
  const imageIds = inputs.assetIds.filter((id) => !attachmentIds.includes(id))
  if (imageIds.length > MAX_IMAGE_ASSETS) {
    logger.warn(
      { workspaceId, images: imageIds.length, max: MAX_IMAGE_ASSETS },
      "handleSendEmail: document images past the cap are not resolved",
    )
  }
  const files = new Map<string, MediaFile>()
  for (const fileId of [
    ...attachmentIds,
    ...imageIds.slice(0, MAX_IMAGE_ASSETS),
  ]) {
    try {
      files.set(
        fileId,
        await mediaLibraryService.findFile({ workspaceId, fileId }),
      )
    } catch (error) {
      // Anything but a 404 (DB, storage) is a real failure and retries.
      if (!isNotFound(error)) {
        throw error
      }
      if (attachmentIds.includes(fileId)) {
        throw new EmailContentError(
          `attachment ${fileId} is not in the media library`,
          { cause: error },
        )
      }
    }
  }
  const assets: Record<string, RenderAsset> = {}
  for (const [fileId, file] of files) {
    assets[fileId] = {
      url: file.url,
      name: file.name,
      size: Number(file.size ?? 0),
      mimeType: file.mimeType ?? "application/octet-stream",
    }
  }
  const attachments = await loadAttachments(
    workspaceId,
    attachmentIds.map((id) => files.get(id) as MediaFile),
  )
  return { doc, inputs, vars, assets, attachments }
}

/**
 * Part 2, after the tracking row exists: sign the tracked template links and
 * flow-button URLs (only when the step has a topic) and render. The package
 * renders synchronously, so the signing is resolved first.
 */
export async function renderStepDocument(props: {
  prepared: PreparedDocument
  workspaceId: string
  appUrl: string
  inbox: InboxWithIntegrations | undefined
  flowId: string | undefined
  unsubscribeUrl: string
  token: string | undefined
}): Promise<{ html: string; text: string; attachments: MailAttachment[] }> {
  const { prepared, workspaceId, appUrl, token } = props
  const { doc, inputs } = prepared

  const track = async (url: string) =>
    token
      ? `${appUrl}/email-topic/click?r=${token}&u=${await signEmailClickUrl(url, workspaceId)}`
      : url

  const links = new Map(
    await Promise.all(
      inputs.links
        .slice(0, MAX_LINKS)
        .map(
          async ({ blockId, url }) =>
            [`${blockId} ${url}`, await track(url)] as const,
        ),
    ),
  )

  const buttons = new Map<string, string>()
  for (const leaf of leafBlocks(doc)) {
    if (leaf.type !== "button") {
      continue
    }
    const button = legacyButton(leaf)
    const url = button
      ? resolveButtonUrl({
          appUrl,
          button,
          inbox: props.inbox,
          flowId: props.flowId,
        })
      : undefined
    if (url) {
      buttons.set(leaf.id, await track(url))
    }
  }

  const rendered = await renderEmail(doc, {
    vars: prepared.vars,
    assets: prepared.assets,
    link: (url, blockId) => links.get(`${blockId} ${url}`) ?? url,
    button: (blockId) => buttons.get(blockId) ?? "",
    unsubscribeUrl: props.unsubscribeUrl,
    openPixelUrl: token ? `${appUrl}/email-topic/open?r=${token}` : undefined,
  })
  if (rendered.missing.length > 0) {
    logger.info(
      { workspaceId, missing: rendered.missing.slice(0, 20) },
      "handleSendEmail: document rendered with unresolved inputs",
    )
  }
  return {
    html: rendered.html,
    text: rendered.text,
    attachments: prepared.attachments,
  }
}
