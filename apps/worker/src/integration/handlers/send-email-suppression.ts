import { emailSuppressionService } from "@chatbotx.io/business/email-suppression"

/** The broadcast failure content a suppressed send is recorded with. */
export const SUPPRESSED_ERROR = "suppressed"

/** Upper bound on addresses in one step's `to`; more fails closed. */
const MAX_RECIPIENTS = 50
const ANGLE_ADDRESS = /<([^<>]*)>\s*$/
const RECIPIENT_SEPARATOR = /[,;]/

/**
 * The bare addresses of a resolved `to` (comma / semicolon separated, each
 * optionally `Name <addr>`). Null when there are none or too many: callers
 * treat that as suppressed.
 */
export function recipientAddresses(to: unknown): string[] | null {
  if (typeof to !== "string") {
    return null
  }
  const addresses = to
    .split(RECIPIENT_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => ANGLE_ADDRESS.exec(part)?.[1]?.trim() ?? part)
  if (addresses.length === 0 || addresses.length > MAX_RECIPIENTS) {
    return null
  }
  return addresses
}

/**
 * Send-time suppression (outreach B-1, s224b): true when ANY recipient of
 * the mail is listed (address or `@domain`) or does not parse as one address.
 * Fails closed: an unusable `to` is suppressed; a lookup error propagates to
 * the queue's retry, never a send.
 */
export async function isSendSuppressed(props: {
  workspaceId: string
  recipient: unknown
}): Promise<boolean> {
  const addresses = recipientAddresses(props.recipient)
  if (!addresses) {
    return true
  }
  for (const address of addresses) {
    if (
      await emailSuppressionService.isSuppressed({
        workspaceId: props.workspaceId,
        address,
      })
    ) {
      return true
    }
  }
  return false
}
