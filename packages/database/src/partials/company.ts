/**
 * Company partials: the stop-rule tag names and the email-domain helpers used
 * to auto-link a contact to a company by the domain of its email address.
 */

import z from "zod"

/**
 * The company change log's row types (s195 CRM 360). `dealCreated`,
 * `dealMoved` and `dealStatusChanged` mirror the DealActivity of a deal that
 * carries this company; the rest are company-side mutations.
 */
export const companyActivityTypes = z.enum([
  "created",
  "updated",
  "stopped",
  "noteAdded",
  "noteDeleted",
  "contactLinked",
  "contactUnlinked",
  "dealCreated",
  "dealMoved",
  "dealStatusChanged",
])
export type CompanyActivityType = z.infer<typeof companyActivityTypes>

/** Applying this tag to a company contact stops the whole company (configurable per workspace). */
export const DEFAULT_COMPANY_STOP_TAG_NAME = "company-stop"

/** Every contact of a stopped company receives this tag so flows and waits can react. */
export const COMPANY_STOPPED_TAG_NAME = "company-stopped"

/**
 * Consumer mailbox domains never identify a company. A contact at one of these
 * is never auto-linked and a company cannot claim one as its domain.
 */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.fr",
  "yahoo.de",
  "yahoo.ca",
  "ymail.com",
  "hotmail.com",
  "hotmail.co.uk",
  "hotmail.fr",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "pm.me",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "mail.com",
  "yandex.com",
  "yandex.ru",
  "zoho.com",
  "fastmail.com",
  "hey.com",
  "comcast.net",
  "att.net",
  "verizon.net",
])

const DOMAIN_JUNK = /[\s/]/
const SCHEME_PREFIX = /^[a-z]+:\/\//
const AT_PREFIX = /^@/
const WHITESPACE = /\s/

/**
 * The lower-cased domain after the last `@`, or null when the value is not an
 * email address (no `@`, empty local part or empty domain).
 */
export function extractEmailDomain(value: unknown): string | null {
  if (typeof value !== "string") {
    return null
  }
  const trimmed = value.trim().toLowerCase()
  const at = trimmed.lastIndexOf("@")
  if (at <= 0 || at === trimmed.length - 1) {
    return null
  }
  const domain = trimmed.slice(at + 1)
  if (!domain.includes(".") || DOMAIN_JUNK.test(domain)) {
    return null
  }
  return domain
}

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domain.trim().toLowerCase())
}

/**
 * Normalise a company domain list: lower-case, strip a leading `@` or scheme,
 * drop empties and duplicates. Free-mail domains are NOT removed here so the
 * caller can reject them with a named error.
 */
export function normalizeCompanyDomains(domains: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of domains) {
    if (typeof raw !== "string") {
      continue
    }
    let d = raw.trim().toLowerCase()
    d = d.replace(SCHEME_PREFIX, "").replace(AT_PREFIX, "")
    d = d.split("/")[0] ?? ""
    if (d.startsWith("www.")) {
      d = d.slice(4)
    }
    if (d.length === 0 || !d.includes(".") || WHITESPACE.test(d)) {
      continue
    }
    if (!out.includes(d)) {
      out.push(d)
    }
  }
  return out
}
