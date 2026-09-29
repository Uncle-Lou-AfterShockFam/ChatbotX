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

/** Media files looked up per send (images + attachments of one document). */
const MAX_ASSETS = 50
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
    const notFound =
      error instanceof ChatbotXException && error.httpStatusCode === 404
    if (
      notFound ||
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
}): Promise<{ html: string; text: string }> {
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

  const assets: Record<string, RenderAsset> = {}
  for (const fileId of inputs.assetIds.slice(0, MAX_ASSETS)) {
    try {
      const file = await mediaLibraryService.findFile({ workspaceId, fileId })
      assets[fileId] = {
        url: file.url,
        name: file.name,
        size: Number(file.size ?? 0),
        mimeType: file.mimeType ?? "application/octet-stream",
      }
    } catch (error) {
      // A deleted file is reported by the renderer as `asset:<id>`; anything
      // else (DB, storage) is a real failure and retries.
      if (
        !(error instanceof ChatbotXException && error.httpStatusCode === 404)
      ) {
        throw error
      }
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
  return { html: rendered.html, text: rendered.text }
}
