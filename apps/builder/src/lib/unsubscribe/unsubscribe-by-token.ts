import { contactService, verifyUnsubscribeToken } from "@chatbotx.io/business"
import { loadServableWorkspace } from "@/lib/workspace/load-servable-workspace"

export type UnsubscribeTokenStatus = "valid" | "invalid" | "unavailable"

/**
 * Verifies an unsubscribe token WITHOUT acting on it (the GET page).
 * `emailOptIn` is the contact's current state (undefined when not found).
 */
export async function checkUnsubscribeToken(
  token: string | null | undefined,
): Promise<{
  status: UnsubscribeTokenStatus
  contactId?: string
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
  return {
    status: "valid",
    contactId: payload.cid,
    emailOptIn: contact?.emailOptIn,
  }
}

/** Verifies the token and opts the contact out of email (the POST routes). */
export async function unsubscribeByToken(
  token: string | null | undefined,
): Promise<UnsubscribeTokenStatus> {
  const checked = await checkUnsubscribeToken(token)
  if (checked.status !== "valid" || !checked.contactId) {
    return checked.status
  }
  await contactService.unsubscribeEmail(checked.contactId)
  return "valid"
}
