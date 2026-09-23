import { companyService, tagService } from "@chatbotx.io/business"
import { stopCompanyForContact } from "@chatbotx.io/business/company-stop"
import type { IntegrationJobCompanyStopOnTag } from "@chatbotx.io/worker-config"
import { logger } from "../../lib/logger"

/**
 * Company stop rule, tag trigger: the workspace's stop tag (default
 * `company-stop`) applied to a contact stops that contact's company. Any
 * other tag is a no-op, so this runs cheaply on every tagApplied.
 */
export async function runCompanyStopOnTag(
  data: IntegrationJobCompanyStopOnTag["data"],
): Promise<void> {
  const { workspaceId, contactId, tagId } = data
  const [tagName, stopTagName] = await Promise.all([
    tagService.findNameByIdForWorkspace({ workspaceId, id: tagId }),
    companyService.resolveStopTagName({ workspaceId }),
  ])
  if (!tagName || tagName !== stopTagName) {
    return
  }
  const result = await stopCompanyForContact({
    workspaceId,
    contactId,
    reason: "tag_applied",
  })
  logger.info(
    { workspaceId, contactId, tagId, result: result.status },
    "company-stop: stop tag applied",
  )
}
