/**
 * Merge tokens: `{{name}}` or `{{name|fallback}}`. Names are whatever the
 * caller resolved into `vars` (packages/variables keys); nothing is invented
 * here. Unknown names render their fallback (or nothing) and are reported in
 * `missing`, never thrown.
 */
const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)(?:\|([^}]*))?\s*\}\}/g
const WHOLE_TOKEN = /^\{\{\s*([a-zA-Z0-9_.]+)(?:\|([^}]*))?\s*\}\}$/
const SAFE_URL = /^(https?:\/\/|mailto:)/i

export type TokenVars = Readonly<Record<string, string>>

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function lookup(
  vars: TokenVars,
  name: string,
  fallback: string | undefined,
  missing: Set<string>,
): string {
  const value = Object.hasOwn(vars, name) ? vars[name] : undefined
  if (typeof value === "string" && value.length > 0) {
    return value
  }
  missing.add(name)
  return fallback?.trim() ?? ""
}

/** Tokens in TEXT: every value is HTML-escaped (a value can never become markup). */
export function mergeText(
  text: string,
  vars: TokenVars,
  missing: Set<string>,
): string {
  return text.replace(TOKEN, (_m, name: string, fallback?: string) =>
    escapeHtml(lookup(vars, name, fallback, missing)),
  )
}

/**
 * Tokens in a URL. A URL that is exactly one token takes the value as the
 * whole URL, and only if it is http(s)/mailto (else ""); a token inside a
 * longer URL is URL-encoded.
 */
export function mergeUrl(
  url: string,
  vars: TokenVars,
  missing: Set<string>,
): string {
  const whole = WHOLE_TOKEN.exec(url)
  if (whole) {
    const value = lookup(vars, whole[1] as string, whole[2], missing).trim()
    return SAFE_URL.test(value) ? value : ""
  }
  return url.replace(TOKEN, (_m, name: string, fallback?: string) =>
    encodeURIComponent(lookup(vars, name, fallback, missing)),
  )
}

/** Tokens in the escaped `href="..."` attributes of already-sanitized HTML. */
export function mergeHtml(
  html: string,
  vars: TokenVars,
  missing: Set<string>,
): string {
  const withHrefs = html.replace(
    /(\shref=")([^"]*)(")/gi,
    (_m, open: string, href: string, close: string) =>
      `${open}${escapeHtml(mergeUrl(unescapeAttr(href), vars, missing))}${close}`,
  )
  return mergeText(withHrefs, vars, missing)
}

function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}
