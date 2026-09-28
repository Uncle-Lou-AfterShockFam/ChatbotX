/**
 * Merge tokens: `{{name}}` or `{{name|fallback}}`. Names are whatever the
 * caller resolved into `vars` (packages/variables keys); nothing is invented
 * here. Unknown names render their fallback (or nothing) and are reported in
 * `missing`, never thrown.
 */
const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)(?:\|([^}]*))?\s*\}\}/g
const WHOLE_TOKEN = /^\{\{\s*([a-zA-Z0-9_.]+)(?:\|([^}]*))?\s*\}\}$/
const SAFE_URL = /^(https?:\/\/|mailto:)/i
const HTTP_ONLY = /^https?:\/\//i
/** Any explicit scheme (`x:`) - a merged URL with a foreign scheme is refused. */
const TOKEN_FREE_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const URL_ATTR_OR_TOKEN =
  /(\s(href|src)=")([^"]*)(")|\{\{\s*([a-zA-Z0-9_.]+)(?:\|([^}]*))?\s*\}\}/gi

export type TokenVars = Readonly<Record<string, string>>

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

type Resolved = { value: string; fromVars: boolean }

function lookup(
  vars: TokenVars,
  name: string,
  fallback: string | undefined,
  missing: Set<string>,
): Resolved {
  const value = Object.hasOwn(vars, name) ? vars[name] : undefined
  if (typeof value === "string" && value.length > 0) {
    return { value, fromVars: true }
  }
  missing.add(name)
  return { value: fallback?.trim() ?? "", fromVars: false }
}

/**
 * A token in TEXT. A var value is HTML-escaped (it can never become markup);
 * a fallback is template text, already escaped/sanitized, so it is kept.
 */
function textToken(
  name: string,
  fallback: string | undefined,
  vars: TokenVars,
  missing: Set<string>,
): string {
  const resolved = lookup(vars, name, fallback, missing)
  return resolved.fromVars ? escapeHtml(resolved.value) : resolved.value
}

/** Tokens in text: ONE pass (a merged value is never re-scanned for tokens). */
export function mergeText(
  text: string,
  vars: TokenVars,
  missing: Set<string>,
): string {
  return text.replace(TOKEN, (_m, name: string, fallback?: string) =>
    textToken(name, fallback, vars, missing),
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
  safe: RegExp = SAFE_URL,
): string {
  const whole = WHOLE_TOKEN.exec(url)
  if (whole) {
    const value = lookup(
      vars,
      whole[1] as string,
      whole[2],
      missing,
    ).value.trim()
    return safe.test(value) ? value : ""
  }
  const merged = url.replace(TOKEN, (_m, name: string, fallback?: string) =>
    encodeURIComponent(lookup(vars, name, fallback, missing).value),
  )
  // A URL that was not http(s)/mailto before merging cannot become one.
  return safe.test(merged) || !TOKEN_FREE_SCHEME.test(merged) ? merged : ""
}

/**
 * Tokens in already-sanitized HTML, in ONE pass: an `href`/`src` attribute
 * is merged as a URL (scheme-checked: `src` http(s) only), every other token
 * as text. A merged value is never re-scanned, so a contact value cannot pull
 * another var into a link.
 */
export function mergeHtml(
  html: string,
  vars: TokenVars,
  missing: Set<string>,
): string {
  return html.replace(
    URL_ATTR_OR_TOKEN,
    (
      match: string,
      open?: string,
      attr?: string,
      url?: string,
      close?: string,
      name?: string,
      fallback?: string,
    ) => {
      if (open !== undefined && url !== undefined && close !== undefined) {
        const safe = attr?.toLowerCase() === "src" ? HTTP_ONLY : SAFE_URL
        return `${open}${escapeHtml(mergeUrl(unescapeAttr(url), vars, missing, safe))}${close}`
      }
      return name ? textToken(name, fallback, vars, missing) : match
    },
  )
}

function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}
