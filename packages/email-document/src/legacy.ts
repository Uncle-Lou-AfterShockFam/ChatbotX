import type { EmailDocument, LeafBlock } from "./schema"

/** Today's email step `elements[]` (flow-config `pageElementSchema`), loosely typed. */
type LegacyElement = {
  id?: string
  type?: string
  text?: string
  url?: string
  label?: string
  buttonType?: string | null
  beforeStep?: unknown
  steps?: unknown[]
}

const SNOWFLAKE = /^\d{1,20}$/
const HTTP = /^(https?:\/\/|mailto:)/i

/**
 * Convert a saved email step's `elements[]` on read (contract sec. 4), so
 * existing flows keep working without migrating flow JSON. Anything that
 * cannot be expressed (an image without a URL, an unknown type) is dropped,
 * never invented.
 */
export function fromLegacyElements(
  elements: unknown,
  options: { preheader?: string } = {},
): EmailDocument {
  const list = Array.isArray(elements) ? (elements as LegacyElement[]) : []
  const blocks: LeafBlock[] = []
  list.slice(0, 200).forEach((el, index) => {
    const id =
      typeof el?.id === "string" && SNOWFLAKE.test(el.id)
        ? el.id
        : String(index + 1)
    switch (el?.type) {
      case "heading":
        blocks.push({
          id,
          type: "heading",
          level: 2,
          text: String(el.text ?? ""),
        })
        break
      case "text":
        blocks.push({ id, type: "text", text: String(el.text ?? "") })
        break
      case "code":
        blocks.push({ id, type: "code", text: String(el.text ?? "") })
        break
      case "image":
        if (typeof el.url === "string" && HTTP.test(el.url)) {
          blocks.push({ id, type: "image", src: el.url, alt: "" })
        }
        break
      case "line":
        blocks.push({ id, type: "divider" })
        break
      case "spacing":
        blocks.push({ id, type: "spacer", height: 24 })
        break
      case "button":
        if (
          el.buttonType &&
          el.beforeStep &&
          typeof el.beforeStep === "object"
        ) {
          blocks.push({
            id,
            type: "button",
            label: String(el.label ?? "Open").slice(0, 40) || "Open",
            action: {
              kind: "flow",
              beforeStep: el.beforeStep as Record<string, unknown>,
              steps: (Array.isArray(el.steps) ? el.steps : []) as Record<
                string,
                unknown
              >[],
            },
          })
        }
        break
      default:
        break
    }
  })
  if (blocks.length === 0) {
    blocks.push({ id: "1", type: "text", text: "" })
  }
  return {
    version: 1,
    settings: options.preheader
      ? { preheader: options.preheader.slice(0, 150) }
      : {},
    blocks,
  }
}
