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
import { contactVariableService } from "@chatbotx.io/variables"
import { resolveButtonUrl } from "../../lib/convert-button"
import { logger } from "../../lib/logger"

/** Image files looked up per send; attachments are counted separately. */
const MAX_IMAGE_ASSETS = 50
/** Distinct files attached to one email. */
export const MAX_ATTACHMENTS = 10
/** Total attachment bytes per email, measured on the stored object. */
export const MAX_ATTACHMENT_BYTES_TOTAL = 10 * 1024 * 1024
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

/** A nodemailer attachment, fully buffered so a re-invoked send can resend it. */
export type MailAttachment = {
  filename: string
  content: Buffer
  contentType: string
}

const MIME_TYPE = /^[\w.+-]{1,64}\/[\w.+-]{1,64}$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g
const PATH_SEPARATOR = /[\\/]/

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
 * `size` is client-supplied. A missing object or an over-budget total is
 * unusable content; any other storage error propagates to the retry.
 */
export async function loadAttachments(
  files: MediaFile[],
): Promise<MailAttachment[]> {
  let total = 0
  const out: MailAttachment[] = []
  for (const file of files) {
    let object: Awaited<ReturnType<typeof uploader.getObjectStream>>
    try {
      object = await uploader.getObjectStream(file.path)
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
    if (
      contentLength !== undefined &&
      total + contentLength > MAX_ATTACHMENT_BYTES_TOTAL
    ) {
      stream.destroy()
      throw tooLarge()
    }
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buf.length
      if (total > MAX_ATTACHMENT_BYTES_TOTAL) {
        stream.destroy()
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
    })
  }
  return out
}

/** The stored name is client-supplied: no control chars or path parts. */
function attachmentName(name: string | null | undefined, id: string): string {
  const base = (name ?? "")
    .replace(CONTROL_CHARS, "")
    .split(PATH_SEPARATOR)
    .pop()
    ?.trim()
    .slice(0, 200)
  return base || `attachment-${id}`
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

/**
 * B2 phase 2b: render a template / inline document for one recipient. The
 * package renders synchronously, so everything asynchronous is resolved
 * first from `collectRenderInputs`: merge values (the contact variable
 * resolvers), tracked template links and flow-button URLs (signed click
 * URLs, only when the step has a topic), and media files.
 */
export async function renderStepDocument(props: {
  step: EmailStepSchema
  workspaceId: string
  appUrl: string
  variables: Variables
  inbox: InboxWithIntegrations | undefined
  flowId: string | undefined
  unsubscribeUrl: string
  token: string | undefined
}): Promise<{ html: string; text: string; attachments: MailAttachment[] }> {
  const { step, workspaceId, appUrl, token } = props
  const doc = await loadDocument(step, workspaceId)
  const inputs = collectRenderInputs(doc)

  const vars =
    inputs.tokenNames.length > 0
      ? await contactVariableService.resolveMapping({
          text: inputs.tokenNames.map((name) => `{{${name}}}`).join(" "),
          variables: props.variables,
        })
      : {}

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

  const rendered = await renderEmail(doc, {
    vars,
    assets,
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
  const attachments = await loadAttachments(
    attachmentIds.map((id) => files.get(id) as MediaFile),
  )
  return { html: rendered.html, text: rendered.text, attachments }
}
