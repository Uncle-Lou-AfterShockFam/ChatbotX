import { contactService, verifyUnsubscribeToken } from "@chatbotx.io/business"
import { contactSequenceService } from "@chatbotx.io/business/contact-sequence"
import { logger } from "@/lib/log"
import { loadServableWorkspace } from "@/lib/workspace/load-servable-workspace"

export type UnsubscribeTokenStatus = "valid" | "invalid" | "unavailable"

/**
 * Verifies an unsubscribe token WITHOUT acting on it (the GET page).
 * `emailOptIn` is the contact's current state.
 */
export async function checkUnsubscribeToken(
  token: string | null | undefined,
): Promise<{
  status: UnsubscribeTokenStatus
  contactId?: string
  workspaceId?: string
  emailOptIn?: boolean
}> {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) {
    return { status: "invalid" }
  }
  let payload: Awaited<ReturnType<typeof verifyUnsubscribeToken>>
  try {
    payload = await verifyUnsubscribeToken(token)
  } catch {
    return { status: "invalid" }
  }
  const { servable } = await loadServableWorkspace(payload.wid)
  if (!servable) {
    return { status: "unavailable" }
  }
  const contact = await contactService.findById({
    workspaceId: payload.wid,
    id: payload.cid,
  })
  // A contact that is not in the token's workspace makes the token invalid.
  if (!contact) {
    return { status: "invalid" }
  }
  return {
    status: "valid",
    contactId: payload.cid,
    workspaceId: payload.wid,
    emailOptIn: contact.emailOptIn,
  }
}

/** Verifies the token and opts the contact out of email (the POST routes). */
export async function unsubscribeByToken(
  token: string | null | undefined,
): Promise<UnsubscribeTokenStatus> {
  const checked = await checkUnsubscribeToken(token)
  if (
    checked.status !== "valid" ||
    !(checked.contactId && checked.workspaceId)
  ) {
    return checked.status
  }
  await contactService.unsubscribeEmail(checked.contactId, checked.workspaceId)
  // s228b: an unsubscribe also ends the contact's outreach sequences for
  // good. Best effort: the opt-out above already stops every email send.
  await contactSequenceService
    .endOutreach({
      workspaceId: checked.workspaceId,
      contactId: checked.contactId,
      reason: "unsubscribed",
    })
    .catch((err: unknown) => {
      logger.warn(
        { err, workspaceId: checked.workspaceId },
        "unsubscribe: ending the outreach enrolments failed",
      )
    })
  return "valid"
}
