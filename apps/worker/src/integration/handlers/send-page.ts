import { createHash } from "node:crypto"
import {
  contactCustomFieldService,
  customFieldService,
  resolveTenantSettings,
} from "@chatbotx.io/business"
import {
  PAGE_LINK_FIELD,
  pageLinkUrl,
  pageService,
} from "@chatbotx.io/business/page"
import type { SendPageStepSchema } from "@chatbotx.io/flow-config"
import { customFieldResolutionKey } from "@chatbotx.io/utils/custom-field"
import { logger } from "../../lib/logger"
import type { ExecuteStepProps } from "./flow-utils"
import type { ExecuteStepResult } from "./step"

/**
 * One link per (flow run, step): a BullMQ retry of this step reuses the link
 * the first attempt minted instead of texting a second one. Hashed because a
 * run key is not ref-safe.
 */
export const pageLinkRef = (flowExecutionKey: string, stepId: string) =>
  `page:${createHash("sha256")
    .update(JSON.stringify([flowExecutionKey, stepId]))
    .digest("hex")
    .slice(0, 40)}`

/**
 * Custom pages (roadmap B4, s227a): mints the contact's link to the step's
 * page and writes its URL to the contact field `page_link`, so the next text
 * or email step sends `{{page_link}}`. Error: no page picked, the page is
 * archived or not in this workspace, the contact is gone, or the run has no
 * key (every retry would mint a new link).
 */
export async function handleSendPage({
  conversation,
  contactInbox,
  step,
  flowExecutionKey,
}: ExecuteStepProps<SendPageStepSchema>): Promise<ExecuteStepResult> {
  const { workspaceId, contactId } = conversation
  if (!step.pageId) {
    return { status: "error", errorMessage: "No page picked", result: null }
  }
  if (!flowExecutionKey) {
    return {
      status: "error",
      errorMessage: "Flow run has no execution key",
      result: null,
    }
  }
  try {
    const link = await pageService.mintLink({
      workspaceId,
      pageId: step.pageId,
      contactId,
      contactInboxId: contactInbox.id,
      ttlHours: step.ttlHours,
      ref: pageLinkRef(flowExecutionKey, step.id),
    })
    const { appUrl } = await resolveTenantSettings({ workspaceId })
    const url = pageLinkUrl(appUrl, link.token)
    const field = { name: PAGE_LINK_FIELD, type: "shortText" as const }
    const { idMap } = await customFieldService.resolveByNameAndType({
      workspaceId,
      fields: [field],
    })
    await contactCustomFieldService.setValueByKey({
      workspaceId,
      contactId,
      keyword: idMap.get(customFieldResolutionKey(field)) ?? field.name,
      value: url,
      contactInboxId: contactInbox.id,
    })
    return {
      status: "success",
      result: { pageLinkId: link.id, expiresAt: link.expiresAt.toISOString() },
    }
  } catch (error) {
    logger.warn(
      { err: error, workspaceId, contactId, stepId: step.id },
      "sendPage failed",
    )
    return {
      status: "error",
      errorMessage: error instanceof Error ? error.message : "sendPage failed",
      result: null,
    }
  }
}
