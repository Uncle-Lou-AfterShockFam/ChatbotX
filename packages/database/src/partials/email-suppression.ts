import z from "zod"

/**
 * Email suppression (outreach B-1, s224b): a per-workspace list of addresses
 * and `@domain` entries the email step never sends to. Checked just before
 * hand-off on both the SMTP and the line path.
 *
 * A domain entry matches that exact domain only: `@acme.com` does NOT cover
 * `mail.acme.com` (list the subdomain as its own entry).
 */
export const emailSuppressionKinds = z.enum(["address", "domain"])
export type EmailSuppressionKind = z.infer<typeof emailSuppressionKinds>

export const emailSuppressionReasons = z.enum(["manual", "unreachable"])
export type EmailSuppressionReason = z.infer<typeof emailSuppressionReasons>

/** RFC 5321 path limit; longer input is never a deliverable address. */
export const EMAIL_SUPPRESSION_MAX_LENGTH = 254

export type EmailSuppressionRefusal =
  | "not-a-string"
  | "empty"
  | "too-long"
  | "whitespace"
  | "no-at"
  | "multiple-at"
  | "bad-domain"

export type ParsedEmailSuppression =
  | { ok: true; kind: EmailSuppressionKind; value: string }
  | { ok: false; reason: EmailSuppressionRefusal }

const WHITESPACE = /\s/
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

function isValidDomain(domain: string): boolean {
  const labels = domain.split(".")
  return labels.length >= 2 && labels.every((label) => DOMAIN_LABEL.test(label))
}

/**
 * The closed parser for a suppression entry: `@domain` -> a domain entry,
 * `local@domain` -> an address entry, anything else is refused with a reason.
 * The value is trimmed and lower-cased. Never throws.
 */
export function parseEmailSuppression(input: unknown): ParsedEmailSuppression {
  if (typeof input !== "string") {
    return { ok: false, reason: "not-a-string" }
  }
  const value = input.trim().toLowerCase()
  if (value.length === 0) {
    return { ok: false, reason: "empty" }
  }
  if (value.length > EMAIL_SUPPRESSION_MAX_LENGTH) {
    return { ok: false, reason: "too-long" }
  }
  if (WHITESPACE.test(value)) {
    return { ok: false, reason: "whitespace" }
  }
  const at = value.indexOf("@")
  if (at === -1) {
    return { ok: false, reason: "no-at" }
  }
  if (value.indexOf("@", at + 1) !== -1) {
    return { ok: false, reason: "multiple-at" }
  }
  const domain = value.slice(at + 1)
  if (!isValidDomain(domain)) {
    return { ok: false, reason: "bad-domain" }
  }
  if (at === 0) {
    return { ok: true, kind: "domain", value }
  }
  return { ok: true, kind: "address", value }
}

/**
 * The two suppression values that block `address`: the address itself and
 * its `@domain`. Null when `address` is not a single parseable address, which
 * callers MUST treat as suppressed (fail closed).
 */
export function emailSuppressionKeysFor(
  address: unknown,
): [string, string] | null {
  const parsed = parseEmailSuppression(address)
  if (!parsed.ok || parsed.kind !== "address") {
    return null
  }
  return [parsed.value, parsed.value.slice(parsed.value.indexOf("@"))]
}
