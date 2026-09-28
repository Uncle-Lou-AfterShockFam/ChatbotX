import { htmlToText } from "html-to-text"
import type { MailElementSchema } from "./emails/dynamic-template"

/** Longest element text the plain-text part carries (the HTML is unbounded). */
const MAX_TEXT_LENGTH = 200_000

const ANCHOR_HREF = /(<a\b[^>]*\bhref\s*=\s*")([^"]*)(")/gi
const HTTP_URL = /^https?:\/\//i
const AMP_ENTITY = /&amp;/g
const AMP = /&/g
const QUOTE = /"/g

/** Tiptap HTML -> readable text (html-to-text, as the rest of the repo). */
export function htmlToPlainText(html: string): string {
  if (typeof html !== "string" || html.length === 0) {
    return ""
  }
  return htmlToText(html.slice(0, MAX_TEXT_LENGTH), {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
    ],
  }).trim()
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

/** Rewriting stops (the fragment is returned as is) past these caps. */
const MAX_REWRITE_HTML_LENGTH = 200_000
const MAX_REWRITE_ANCHORS = 200

/** The http(s) hrefs of an HTML fragment, decoded, in order. */
export function extractHttpHrefs(html: string): string[] {
  if (typeof html !== "string" || html.length === 0) {
    return []
  }
  return [...html.slice(0, MAX_REWRITE_HTML_LENGTH).matchAll(ANCHOR_HREF)]
    .map((match) => decodeHtmlAttr(match[2] ?? ""))
    .filter((href) => HTTP_URL.test(href))
}

/**
 * Rewrites the http(s) `href`s of an HTML fragment through `rewrite` (click
 * tracking), but ONLY those in `allowed`. Callers pass the hrefs the
 * operator typed into the template BEFORE merge fields were filled in, so a
 * link injected through a contact's field value is never signed by the hub.
 * Non-http schemes are never rewritten. A fragment over the size or anchor
 * cap is returned unchanged (untracked, never truncated).
 */
export async function rewriteHtmlLinks(
  html: string,
  rewrite: (url: string) => Promise<string>,
  allowed: ReadonlySet<string>,
): Promise<string> {
  if (typeof html !== "string" || html.length === 0) {
    return ""
  }
  if (html.length > MAX_REWRITE_HTML_LENGTH || allowed.size === 0) {
    return html
  }
  const matches = [...html.matchAll(ANCHOR_HREF)]
  if (matches.length === 0 || matches.length > MAX_REWRITE_ANCHORS) {
    return html
  }
  let out = ""
  let last = 0
  for (const match of matches) {
    const [whole, open, rawHref, close] = match
    const index = match.index ?? 0
    const href = decodeHtmlAttr(rawHref ?? "")
    out += html.slice(last, index)
    if (HTTP_URL.test(href) && allowed.has(href)) {
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
