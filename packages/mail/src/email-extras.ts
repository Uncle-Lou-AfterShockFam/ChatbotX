import type { MailElementSchema } from "./emails/dynamic-template"

/** Longest element text the plain-text part carries (the HTML is unbounded). */
const MAX_TEXT_LENGTH = 200_000

const ANCHOR_WITH_LABEL =
  /<a\b[^>]*\bhref\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
const ANCHOR_HREF = /(<a\b[^>]*\bhref\s*=\s*")([^"]*)(")/gi
const HTTP_URL = /^https?:\/\//i
const TAG = /<[^>]*>/g
const BR = /<br\s*\/?>/gi
const BLOCK_END = /<\/(p|div|h[1-6]|li|ul|ol|blockquote)>/gi
const LI_START = /<li\b[^>]*>/gi
const ENTITY = /&(amp|lt|gt|quot|#39|nbsp);/g
const TRAILING_SPACE = /[ \t]+\n/g
const EXTRA_BREAKS = /\n{3,}/g
const AMP_ENTITY = /&amp;/g
const AMP = /&/g
const QUOTE = /"/g

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
}

/** Tiptap HTML -> readable text: block tags become line breaks, links keep their URL. */
export function htmlToPlainText(html: string): string {
  if (typeof html !== "string" || html.length === 0) {
    return ""
  }
  return html
    .slice(0, MAX_TEXT_LENGTH)
    .replace(ANCHOR_WITH_LABEL, (_m, href: string, label: string) => {
      const text = label.replace(TAG, "").trim()
      return text && text !== href ? `${text} (${href})` : href
    })
    .replace(BR, "\n")
    .replace(BLOCK_END, "\n")
    .replace(LI_START, "- ")
    .replace(TAG, "")
    .replace(ENTITY, (entity) => ENTITIES[entity] ?? entity)
    .replace(TRAILING_SPACE, "\n")
    .replace(EXTRA_BREAKS, "\n\n")
    .trim()
}

/**
 * The text/plain alternative of a dynamic email, built from the same resolved
 * elements as the HTML (never by scraping the MJML output). Images and the
 * open pixel are dropped; a button becomes "label: url".
 */
export function renderDynamicEmailText(elements: MailElementSchema[]): string {
  if (!Array.isArray(elements)) {
    return ""
  }
  const parts: string[] = []
  for (const element of elements) {
    switch (element.type) {
      case "heading":
      case "text":
      case "code": {
        const text =
          element.type === "code" ? element.text : htmlToPlainText(element.text)
        if (text) {
          parts.push(text)
        }
        break
      }
      case "button":
        if (element.url) {
          parts.push(`${element.label ?? "Open"}: ${element.url}`)
        }
        break
      case "line":
        parts.push("----")
        break
      default:
        break
    }
  }
  return parts.join("\n\n")
}

/**
 * Rewrites every http(s) `href` in an HTML fragment through `rewrite`
 * (click tracking). `keep` URLs (the unsubscribe link) and non-http schemes
 * (mailto:, tel:) are left alone. `rewrite` must return an absolute URL.
 */
export async function rewriteHtmlLinks(
  html: string,
  rewrite: (url: string) => Promise<string>,
  keep: ReadonlySet<string> = new Set(),
): Promise<string> {
  if (typeof html !== "string" || html.length === 0) {
    return ""
  }
  const matches = [...html.matchAll(ANCHOR_HREF)]
  if (matches.length === 0) {
    return html
  }
  let out = ""
  let last = 0
  for (const match of matches) {
    const [whole, open, rawHref, close] = match
    const index = match.index ?? 0
    const href = decodeHtmlAttr(rawHref ?? "")
    out += html.slice(last, index)
    if (HTTP_URL.test(href) && !keep.has(href)) {
      out += `${open}${encodeHtmlAttr(await rewrite(href))}${close}`
    } else {
      out += whole
    }
    last = index + whole.length
  }
  return out + html.slice(last)
}

function decodeHtmlAttr(value: string): string {
  return value.replace(AMP_ENTITY, "&")
}

function encodeHtmlAttr(value: string): string {
  return value.replace(AMP, "&amp;").replace(QUOTE, "&quot;")
}
