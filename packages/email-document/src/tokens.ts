import {
  escapeHtml,
  renderTemplate,
  type TokenVars,
  templateNames,
} from "./liquid"

export { escapeHtml, type TokenVars } from "./liquid"

/**
 * Merge tokens are Liquid (s227b; `./liquid.ts` is the one evaluator), with
 * the legacy `{{name}}` / `{{name|fallback}}` grammar still honoured. A legacy
 * name is the hub's own grammar (@chatbotx.io/utils VARIABLE_PLACEHOLDER_SOURCE:
 * any run of characters other than a brace or newline, trimmed - so
 * `{{bot_field:12}}`, `{{coupon:SUMMER}}` and `{{raw:x}}` are names too),
 * minus `|`, which starts the fallback. Every value is escaped for its
 * context; unknown or empty names are reported in `missing`.
 */
export const TOKEN_NAME_SOURCE = String.raw`[^{}\n|]+`
const WHOLE_TOKEN = /^\s*\{\{[^{}]*\}\}\s*$/
const HAS_TAG = /\{%/
const SAFE_URL = /^(https?:\/\/|mailto:)/i
const HTTP_ONLY = /^https?:\/\//i
/** Any explicit scheme (`x:`) - a merged URL with a foreign scheme is refused. */
const TOKEN_FREE_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const URL_ATTR = /(\s(href|src)=")([^"]*)(")/gi
const HAS_TEMPLATE = /\{\{|\{%/

/** Tokens in text (HTML context): values escaped, rendered in ONE pass. */
export function mergeText(
  text: string,
  vars: TokenVars,
  missing: Set<string>,
): string {
  return renderTemplate(text, vars, missing, "html")
}

/** Tokens in a plain-text header (subject/preheader): nothing is escaped. */
export function mergePlain(
  text: string,
  vars: TokenVars,
  missing: Set<string>,
): string {
  return renderTemplate(text, vars, missing, "text")
}

/**
 * Tokens in a URL. A URL that is exactly one output takes the value as the
 * whole URL, and only if it is http(s)/mailto (else ""); an output inside a
 * longer URL is URL-encoded. A `{% tag %}` in a URL refuses the URL.
 */
export function mergeUrl(
  url: string,
  vars: TokenVars,
  missing: Set<string>,
  safe: RegExp = SAFE_URL,
): string {
  if (HAS_TAG.test(url)) {
    return ""
  }
  if (WHOLE_TOKEN.test(url)) {
    const value = renderTemplate(url, vars, missing, "text").trim()
    return safe.test(value) ? value : ""
  }
  const merged = renderTemplate(url, vars, missing, "url")
  // A URL that was not http(s)/mailto before merging cannot become one.
  return safe.test(merged) || !TOKEN_FREE_SCHEME.test(merged) ? merged : ""
}

/**
 * Tokens in already-sanitized HTML: every `href`/`src` attribute with a
 * token is merged as a URL (scheme-checked: `src` http(s) only) and parked
 * behind a per-render nonce, then the HTML is rendered once (values escaped)
 * and the URLs put back. A merged value is never re-scanned, so a contact
 * value cannot pull another var into a link or forge a parked URL.
 */
export function mergeHtml(
  html: string,
  vars: TokenVars,
  missing: Set<string>,
): string {
  const nonce = globalThis.crypto.randomUUID()
  const parked: string[] = []
  const withSlots = html.replace(
    URL_ATTR,
    (match, open: string, attr: string, url: string, close: string) => {
      if (!HAS_TEMPLATE.test(url)) {
        return match
      }
      const safe = attr.toLowerCase() === "src" ? HTTP_ONLY : SAFE_URL
      parked.push(escapeHtml(mergeUrl(unescapeAttr(url), vars, missing, safe)))
      return `${open}\u0000${nonce}:${parked.length - 1}\u0000${close}`
    },
  )
  const rendered = renderTemplate(withSlots, vars, missing, "html")
  if (parked.length === 0) {
    return rendered
  }
  const slot = new RegExp(`\u0000${nonce}:(\\d+)\u0000`, "g")
  return rendered.replace(
    slot,
    (_m, index: string) => parked[Number(index)] ?? "",
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

/** Every name `text` reads (trimmed), for a caller that resolves vars first. */
export function tokenNames(text: string): string[] {
  return templateNames(text)
}
