import { stopCompany } from "../company/stop"
import { logger } from "../logger"

/**
 * A deal event stops the contact's company through the same cascade a reply
 * does, with reason `deal` (which ignores the company's `stopOnReply`
 * opt-out). A failure here is logged and swallowed: the deal write has
 * already committed and must never be reported as failed because a
 * downstream sequence removal threw.
 */
export async function stopCompanyForDeal(props: {
  workspaceId: string
  companyId: string
  dealId: string
  contactId?: string | null
}): Promise<void> {
  try {
    const result = await stopCompany({
      workspaceId: props.workspaceId,
      companyId: props.companyId,
      reason: "deal",
      triggeredByContactId: props.contactId ?? undefined,
    })
    logger.info(
      { ...props, status: result.status },
      "deal: company stop cascade ran",
    )
  } catch (error) {
    logger.warn({ error, ...props }, "deal: company stop cascade failed")
  }
}
