/**
 * Merge tokens: `{{name}}` or `{{name|fallback}}`. A name is the hub's own
 * grammar (@chatbotx.io/utils VARIABLE_PLACEHOLDER_SOURCE: any run of
 * characters other than a brace or newline, trimmed - so `{{bot_field:12}}`,
 * `{{coupon:SUMMER}}` and `{{raw:x}}` are names too), minus `|`, which
 * starts the fallback. `raw:` gets no special treatment: every value is
 * escaped. Names are whatever the caller resolved into `vars`; unknown names
 * render their fallback (or nothing) and are reported in `missing`.
 */
export const TOKEN_NAME_SOURCE = String.raw`[^{}\n|]+`
const TOKEN_BODY = String.raw`\{\{(${TOKEN_NAME_SOURCE})(?:\|([^{}\n]*))?\}\}`
const TOKEN = new RegExp(TOKEN_BODY, "g")
const WHOLE_TOKEN = new RegExp(String.raw`^\s*${TOKEN_BODY}\s*$`)
const SAFE_URL = /^(https?:\/\/|mailto:)/i
const HTTP_ONLY = /^https?:\/\//i
/** Any explicit scheme (`x:`) - a merged URL with a foreign scheme is refused. */
const TOKEN_FREE_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const URL_ATTR_OR_TOKEN = new RegExp(
  String.raw`(\s(href|src)=")([^"]*)(")|${TOKEN_BODY}`,
  "gi",
)

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
  const key = name.trim()
  const value = Object.hasOwn(vars, key) ? vars[key] : undefined
  if (typeof value === "string" && value.length > 0) {
    return { value, fromVars: true }
  }
  missing.add(key)
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

/** Every token name in `text` (trimmed), for a caller that resolves vars first. */
export function tokenNames(text: string): string[] {
  return [...text.matchAll(TOKEN)].map((match) => (match[1] as string).trim())
}
