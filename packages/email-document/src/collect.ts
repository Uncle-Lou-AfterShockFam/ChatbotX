import { sanitizeHtmlBlock, sanitizeRichText } from "./sanitize"
import type { Block, EmailDocument, LeafBlock } from "./schema"
import { tokenNames } from "./tokens"

const HAS_TOKEN = /\{\{/
const HTTP_HREF = /\shref="(https?:\/\/[^"]*)"/gi
const AMP_ENTITY = /&amp;/g

function leaves(doc: EmailDocument): LeafBlock[] {
  return doc.blocks.flatMap((block: Block) =>
    block.type === "columns"
      ? block.columns.flatMap((column) => column.blocks)
      : [block],
  )
}

/**
 * The inputs a caller must resolve BEFORE rendering (the renderers never
 * fetch and their callbacks are synchronous): merge-token names, template
 * links to pre-sign for tracking, flow-button block ids, media file ids.
 * Links are extracted exactly as the renderers will see them (after the same
 * sanitizing), so a pre-signed map keyed by `blockId + url` always hits.
 */
export function collectRenderInputs(doc: EmailDocument): {
  tokenNames: string[]
  links: Array<{ blockId: string; url: string }>
  buttonIds: string[]
  assetIds: string[]
} {
  const names = new Set<string>()
  const links: Array<{ blockId: string; url: string }> = []
  const buttonIds: string[] = []
  const assetIds = new Set<string>()
  const addNames = (text: string | undefined) => {
    if (text) {
      for (const name of tokenNames(text)) {
        names.add(name)
      }
    }
  }
  const addLink = (blockId: string, url: string) => {
    if (!HAS_TOKEN.test(url)) {
      links.push({ blockId, url })
    }
  }
  addNames(doc.settings.preheader)
  for (const leaf of leaves(doc)) {
    switch (leaf.type) {
      case "heading":
      case "text":
      case "html": {
        const raw = leaf.type === "html" ? leaf.html : leaf.text
        addNames(raw)
        const clean =
          leaf.type === "html" ? sanitizeHtmlBlock(raw) : sanitizeRichText(raw)
        for (const match of clean.matchAll(HTTP_HREF)) {
          addLink(leaf.id, (match[1] as string).replace(AMP_ENTITY, "&"))
        }
        break
      }
      case "code":
        addNames(leaf.text)
        break
      case "image":
        addNames(leaf.alt)
        if (typeof leaf.src === "string") {
          addNames(leaf.src)
        } else {
          assetIds.add(leaf.src.fileId)
        }
        if (leaf.href) {
          addNames(leaf.href)
          addLink(leaf.id, leaf.href)
        }
        break
      case "button":
        addNames(leaf.label)
        if (leaf.action.kind === "flow") {
          buttonIds.push(leaf.id)
        } else {
          addNames(leaf.action.url)
          addLink(leaf.id, leaf.action.url)
        }
        break
      case "attachment":
        assetIds.add(leaf.asset.fileId)
        break
      default:
        break
    }
  }
  return {
    tokenNames: [...names].sort(),
    links,
    buttonIds,
    assetIds: [...assetIds].sort(),
  }
}
