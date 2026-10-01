/** The Google OAuth redirect path of a mailbox-sender connect (s230b). */
export const EMAIL_SENDER_CALLBACK_PATH = "/integrations/email-sender/callback"

export const emailSenderSettingsPath = (workspaceId: string) =>
  `/space/${workspaceId}/settings/email-senders`

/**
 * The callback's closed result codes (`?emailSenderConnect=`): an error's
 * text never goes into a URL.
 */
export const EMAIL_SENDER_CONNECT_OUTCOMES = [
  "connected",
  "cancelled",
  "untrusted",
  "scope",
  "mismatch",
  "duplicate",
  "failed",
] as const
export type EmailSenderConnectOutcome =
  (typeof EMAIL_SENDER_CONNECT_OUTCOMES)[number]

export const parseEmailSenderConnectOutcome = (
  value: unknown,
): EmailSenderConnectOutcome | null =>
  typeof value === "string" &&
  (EMAIL_SENDER_CONNECT_OUTCOMES as readonly string[]).includes(value)
    ? (value as EmailSenderConnectOutcome)
    : null

/**
 * Google's `?error=` on the redirect: `admin_policy_enforced` is a Workspace
 * whose admin has not trusted the app's Client ID; `access_denied` is the
 * user declining (or, on some Workspace domains, the same admin block).
 */
export function outcomeOfGoogleError(error: string): EmailSenderConnectOutcome {
  if (error === "admin_policy_enforced" || error === "org_internal") {
    return "untrusted"
  }
  return error === "access_denied" ? "cancelled" : "failed"
}
