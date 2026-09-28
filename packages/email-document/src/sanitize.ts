import sanitizeHtml from "sanitize-html"

/**
 * THE sanitizer for both renderers (contract sec. 4). Email clients strip
 * some dangerous markup; browsers do not, and lane A renders the same bytes
 * on web pages - so nothing is passed through raw.
 */
const RICH_TAGS = [
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "a",
  "ul",
  "ol",
  "li",
  "span",
  "h1",
  "h2",
  "h3",
]

const TEXT_ALIGN = /^(left|right|center|justify)$/
const FONT_WEIGHT = /^(normal|bold|[1-9]00)$/
const FONT_SIZE = /^\d{1,2}(px|em|%)$/
const BOX_PX = /^\d{1,3}px( \d{1,3}px){0,3}$/
const WIDTH = /^\d{1,3}(px|%)$/
const COLOR_ONLY = [
  /^#[0-9a-fA-F]{3,6}$/,
  /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/,
]

const BASE: sanitizeHtml.IOptions = {
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesAppliedToAttributes: ["href", "src"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  // `{{token}}` hrefs survive sanitizing (they are scheme-less) and are
  // resolved + re-checked by mergeUrl, which only admits http(s)/mailto.
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...attribs,
        rel: "noopener noreferrer",
        target: "_blank",
      },
    }),
  },
}

/** Tiptap RichText (text / heading blocks). */
export function sanitizeRichText(html: string): string {
  return sanitizeHtml(html, {
    ...BASE,
    allowedTags: RICH_TAGS,
    allowedAttributes: {
      a: ["href", "rel", "target"],
      span: ["style"],
    },
    allowedStyles: { span: { color: COLOR_ONLY } },
  })
}

/** Imported / raw `html` blocks: layout tags, still no script, style, event handlers or iframes. */
export function sanitizeHtmlBlock(html: string): string {
  return sanitizeHtml(html, {
    ...BASE,
    allowedTags: [
      ...RICH_TAGS,
      "h4",
      "h5",
      "h6",
      "div",
      "table",
      "thead",
      "tbody",
      "tr",
      "td",
      "th",
      "img",
      "hr",
      "blockquote",
      "pre",
      "code",
      "center",
    ],
    allowedAttributes: {
      a: ["href", "rel", "target"],
      img: ["src", "alt", "width", "height"],
      td: ["align", "colspan", "rowspan", "width"],
      th: ["align", "colspan", "rowspan", "width"],
      table: ["width", "cellpadding", "cellspacing", "border", "align"],
      "*": ["style"],
    },
    allowedStyles: {
      "*": {
        color: COLOR_ONLY,
        "background-color": COLOR_ONLY,
        "text-align": [TEXT_ALIGN],
        "font-weight": [FONT_WEIGHT],
        "font-size": [FONT_SIZE],
        padding: [BOX_PX],
        margin: [BOX_PX],
        width: [WIDTH],
      },
    },
  })
}
