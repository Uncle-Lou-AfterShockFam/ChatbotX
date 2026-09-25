import { VARIABLE_PLACEHOLDER_SOURCE } from "@chatbotx.io/utils"

/**
 * Document HTML (roadmap B3). A template body is the builder editor's HTML
 * with `{{variable}}` merge fields. Unlike message text, the result is HTML:
 * every merge VALUE is HTML-escaped, and a value may not contain `{{` / `}}`
 * because `{{signature, r1}}`-style text in the rendered PDF becomes a
 * Documenso signing field (a contact named "{{signature, r2}}" must not plant
 * one). Unknown placeholders stay as written (the message-text rule), which
 * is exactly what keeps the Documenso placeholders intact.
 */

const PLACEHOLDER = new RegExp(VARIABLE_PLACEHOLDER_SOURCE, "g")
const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}
export const MAX_MERGE_VALUE_LENGTH = 2000
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch)

export class DocumentMergeError extends Error {
  readonly variable: string
  constructor(variable: string, message: string) {
    super(message)
    this.name = "DocumentMergeError"
    this.variable = variable
  }
}

/** Every `{{...}}` key in the body (trimmed, unique), for the caller's resolver. */
export const documentVariables = (bodyHtml: string): string[] => [
  ...new Set(Array.from(bodyHtml.matchAll(PLACEHOLDER), (m) => m[1].trim())),
]

/**
 * Merge `mapping` into `bodyHtml`. Throws DocumentMergeError for a value that
 * is too long, carries control characters, or contains `{{` / `}}`.
 */
export const mergeDocumentHtml = (
  bodyHtml: string,
  mapping: Record<string, string>,
): string => {
  for (const [key, value] of Object.entries(mapping)) {
    if (value.length > MAX_MERGE_VALUE_LENGTH) {
      throw new DocumentMergeError(key, `{{${key}}} is longer than ${MAX_MERGE_VALUE_LENGTH} characters`)
    }
    if (CONTROL_CHARS.test(value)) {
      throw new DocumentMergeError(key, `{{${key}}} contains a control character`)
    }
    if (value.includes("{{") || value.includes("}}")) {
      throw new DocumentMergeError(key, `{{${key}}} may not contain {{ or }}`)
    }
  }
  return bodyHtml.replace(PLACEHOLDER, (match, variable: string) => {
    const value = Object.hasOwn(mapping, variable.trim())
      ? mapping[variable.trim()]
      : undefined
    // Newlines in a value (a multi-line custom field) read as line breaks.
    return value === undefined ? match : escapeHtml(value).replace(/\r?\n/g, "<br>")
  })
}

/**
 * The full page Gotenberg renders: a fixed print stylesheet around the
 * merged body. Self-contained (no remote fonts or images): Gotenberg runs
 * with network fetches denied.
 */
export const wrapDocumentHtml = (title: string, body: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
@page { size: Letter; margin: 22mm 20mm; }
body { font-family: Helvetica, Arial, sans-serif; font-size: 11.5pt; line-height: 1.5; color: #111; }
h1 { font-size: 20pt; margin: 0 0 4mm; } h2 { font-size: 15pt; margin: 6mm 0 3mm; } h3 { font-size: 12.5pt; margin: 5mm 0 2mm; }
p { margin: 0 0 3mm; } ul, ol { margin: 0 0 3mm; padding-left: 7mm; } li { margin-bottom: 1.5mm; }
table { border-collapse: collapse; width: 100%; } td, th { border: 1px solid #999; padding: 1.5mm 2mm; }
.doc-sign { margin-top: 12mm; display: grid; grid-template-columns: 1fr 1fr; gap: 10mm; }
.doc-sign-line { border-top: 1px solid #111; padding-top: 1.5mm; font-size: 9.5pt; color: #444; }
.doc-ph-sig { font-size: 22pt; color: #fff; white-space: nowrap; }
.doc-ph-date { font-size: 13pt; color: #fff; white-space: nowrap; }
</style></head><body>${body}</body></html>`
