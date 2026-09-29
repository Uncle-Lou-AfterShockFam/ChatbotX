import { mediaLibraryService, signEmailClickUrl } from "@chatbotx.io/business"
import { emailTemplateService } from "@chatbotx.io/business/email-templates"
import type { InboxWithIntegrations } from "@chatbotx.io/database/types"
import {
  collectRenderInputs,
  type EmailDocument,
  parseDocument,
  type RenderAsset,
} from "@chatbotx.io/email-document"
import { renderEmail } from "@chatbotx.io/email-document/render-email"
import type {
  EmailStepSchema,
  PageElementSchema,
} from "@chatbotx.io/flow-config"
import { contactVariableService } from "@chatbotx.io/variables"
import { resolveButtonUrl } from "../../lib/convert-button"
import { logger } from "../../lib/logger"

/** Media files looked up per send (images + attachments of one document). */
const MAX_ASSETS = 50

/** beforeStep.stepType -> the legacy buttonType resolveButtonUrl reads. */
const BUTTON_TYPE_BY_STEP: Record<string, string> = {
  openWebsite: "openWebsite",
  startExternalFlow: "startExternalFlow",
  startExternalNode: "startExternalNode",
  startAnotherNode: "startAnotherNode",
}

type Variables = Awaited<ReturnType<typeof contactVariableService.getAll>>

/** The step's document: a saved template, else the inline document. */
async function loadDocument(
  step: EmailStepSchema,
  workspaceId: string,
): Promise<EmailDocument> {
  if (step.templateId) {
    return await emailTemplateService.getDocument({
      workspaceId,
      id: step.templateId,
    })
  }
  return parseDocument(step.document)
}

/**
 * B2 phase 2b: render a template / inline document for one recipient. The
 * package renders synchronously, so everything asynchronous is resolved
 * first from `collectRenderInputs`: merge values (the contact variable
 * resolvers), tracked template links (signed click URLs, only when the step
 * has a topic), flow-button URLs and media files.
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

  const links = new Map<string, string>()
  for (const { blockId, url } of inputs.links) {
    links.set(`${blockId} ${url}`, await track(url))
  }

  const buttons = new Map<string, string>()
  for (const leaf of doc.blocks.flatMap((block) =>
    block.type === "columns"
      ? block.columns.flatMap((column) => column.blocks)
      : [block],
  )) {
    if (leaf.type !== "button" || leaf.action.kind !== "flow") {
      continue
    }
    const stepType = String(leaf.action.beforeStep.stepType ?? "")
    const buttonType = BUTTON_TYPE_BY_STEP[stepType]
    if (!buttonType) {
      continue
    }
    const url = resolveButtonUrl({
      appUrl,
      button: {
        id: leaf.id,
        type: "button",
        label: leaf.label,
        buttonType,
        beforeStep: leaf.action.beforeStep,
        steps: leaf.action.steps,
      } as unknown as Extract<PageElementSchema, { type: "button" }>,
      inbox: props.inbox,
      flowId: props.flowId,
    })
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
    } catch {
      // Reported by the renderer as `asset:<id>` in `missing`.
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
