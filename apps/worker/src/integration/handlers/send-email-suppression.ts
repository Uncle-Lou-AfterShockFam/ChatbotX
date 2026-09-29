import { emailSuppressionService } from "@chatbotx.io/business/email-suppression"
import { parseRecipientAddresses } from "@chatbotx.io/mail/extras"

/** The broadcast failure content a suppressed send is recorded with. */
export const SUPPRESSED_ERROR = "suppressed"

/** Upper bound on addresses in one step's `to`; more fails closed. */
const MAX_RECIPIENTS = 50

/**
 * The bare addresses a resolved `to` is delivered to, parsed exactly as
 * nodemailer parses it on send. Null when there are none, too many, or one
 * entry has no address: callers treat that as suppressed.
 */
export function recipientAddresses(to: unknown): string[] | null {
  if (typeof to !== "string") {
    return null
  }
  const addresses = parseRecipientAddresses(to)
  if (
    addresses.length === 0 ||
    addresses.length > MAX_RECIPIENTS ||
    addresses.some((address) => address === "")
  ) {
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
