import { type EmailDocument, type LeafBlock, leafBlockSchema } from "./schema"

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
  const str = (value: unknown): string => {
    try {
      return typeof value === "string" ? value : String(value ?? "")
    } catch {
      return ""
    }
  }
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
          text: str(el.text),
        })
        break
      case "text":
        blocks.push({ id, type: "text", text: str(el.text) })
        break
      case "code":
        blocks.push({ id, type: "code", text: str(el.text) })
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
            label: str(el.label).trim().slice(0, 40) || "Open",
            action: {
              kind: "flow",
              beforeStep: el.beforeStep as Record<string, unknown>,
              steps: (Array.isArray(el.steps) ? el.steps : [])
                .filter(
                  (step) =>
                    step !== null &&
                    typeof step === "object" &&
                    !Array.isArray(step),
                )
                .slice(0, 20) as Record<string, unknown>[],
            },
          })
        }
        break
      default:
        break
    }
  })
  // Every converted block must pass the schema on its own: a stored flow
  // with one odd element keeps rendering instead of failing parseDocument.
  const valid = blocks.filter(
    (block) => leafBlockSchema.safeParse(block).success,
  )
  if (valid.length === 0) {
    valid.push({ id: "1", type: "text", text: "" })
  }
  return {
    version: 1,
    settings:
      typeof options.preheader === "string" && options.preheader
        ? { preheader: options.preheader.slice(0, 150) }
        : {},
    blocks: valid,
  }
}
