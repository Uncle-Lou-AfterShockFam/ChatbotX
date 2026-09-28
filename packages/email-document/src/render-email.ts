import { htmlToText } from "html-to-text"
import mjml2html from "mjml"
import {
  assertLeaf,
  attachmentsOf,
  plainText,
  prepareRich,
  type RenderContext,
  resolveButtonHref,
  resolveSrc,
  resolveTemplateUrl,
} from "./context"
import { parseDocument } from "./parse"
import { blockToHtml } from "./render-web"
import type { AssetRef, EmailDocument, LeafBlock } from "./schema"
import { escapeHtml } from "./tokens"

export type { RenderAsset, RenderContext } from "./context"

const FONT_STACKS: Record<string, string> = {
  system: "Helvetica,Arial,sans-serif",
  arial: "Arial,Helvetica,sans-serif",
  georgia: "Georgia,serif",
  helvetica: "Helvetica,Arial,sans-serif",
  times: "'Times New Roman',Times,serif",
  verdana: "Verdana,Geneva,sans-serif",
}

function leafToMjml(
  block: LeafBlock,
  ctx: RenderContext,
  missing: Set<string>,
): string {
  const align = (value?: string) => (value ? ` align="${value}"` : "")
  switch (block.type) {
    case "heading": {
      const size = { 1: 28, 2: 22, 3: 18 }[block.level]
      return `<mj-text font-size="${size}px" font-weight="700" line-height="1.3"${align(block.align)}>${prepareRich(block.text, block.id, ctx, missing, "rich")}</mj-text>`
    }
    case "text":
      return `<mj-text font-size="16px" line-height="1.5"${align(block.align)}>${prepareRich(block.text, block.id, ctx, missing, "rich")}</mj-text>`
    case "code":
      return `<mj-text font-family="monospace" font-size="14px" container-background-color="#f4f4f5">${plainText(block.text, ctx, missing).replace(/\n/g, "<br />")}</mj-text>`
    case "image": {
      const src = resolveSrc(block.src, ctx, missing)
      if (!src) {
        return ""
      }
      const href = block.href
        ? resolveTemplateUrl(block.href, block.id, ctx, missing)
        : ""
      const width = block.width ? ` width="${block.width}px"` : ""
      return `<mj-image src="${escapeHtml(src)}" alt="${plainText(block.alt, ctx, missing)}"${href ? ` href="${escapeHtml(href)}"` : ""}${width} />`
    }
    case "button": {
      const href = resolveButtonHref(block, ctx, missing)
      if (!href) {
        return ""
      }
      return `<mj-button href="${escapeHtml(href)}" background-color="${block.color ?? "#111111"}" color="#ffffff" font-weight="700" border-radius="4px"${align(block.align)}>${plainText(block.label, ctx, missing)}</mj-button>`
    }
    case "divider":
      return `<mj-divider border-color="#e8e8e8" border-width="1px" />`
    case "spacer":
      return `<mj-spacer height="${block.height}px" />`
    case "html":
      return `<mj-text>${prepareRich(block.html, block.id, ctx, missing, "html")}</mj-text>`
    case "attachment":
      // A real MIME attachment (see `attachments`), never inline markup.
      return ""
    default:
      return ""
  }
}

export type RenderEmailResult = {
  html: string
  text: string
  attachments: AssetRef[]
  missing: string[]
}

/** MJML -> HTML + a text/plain part from the same prepared blocks. */
export async function renderEmail(
  input: EmailDocument | unknown,
  ctx: RenderContext,
): Promise<RenderEmailResult> {
  const doc = parseDocument(input)
  const missing = new Set<string>()
  // One callback call per link/button across BOTH parts: the callbacks may
  // mint tracking tokens, and the HTML and text parts must agree.
  const linkMemo = new Map<string, string>()
  const buttonMemo = new Map<string, string>()
  const link = ctx.link
  const button = ctx.button
  const memoCtx: RenderContext = {
    ...ctx,
    link: link
      ? (url, blockId) => {
          const key = `${blockId}\u0000${url}`
          const hit = linkMemo.get(key)
          if (hit !== undefined) {
            return hit
          }
          const out = link(url, blockId)
          linkMemo.set(key, out)
          return out
        }
      : undefined,
    button: button
      ? (blockId) => {
          const hit = buttonMemo.get(blockId)
          if (hit !== undefined) {
            return hit
          }
          const out = button(blockId)
          buttonMemo.set(blockId, out)
          return out
        }
      : undefined,
  }
  const sections = doc.blocks
    .map((block) => {
      if (block.type !== "columns") {
        const inner = leafToMjml(block, memoCtx, missing)
        return inner
          ? `<mj-section><mj-column>${inner}</mj-column></mj-section>`
          : ""
      }
      const columns = block.columns
        .map(
          (column) =>
            `<mj-column>${column.blocks.map((leaf) => leafToMjml(assertLeaf(leaf), memoCtx, missing)).join("")}</mj-column>`,
        )
        .join("")
      return `<mj-section>${columns}</mj-section>`
    })
    .join("\n")
  const pixel = ctx.openPixelUrl
    ? `<mj-section><mj-column><mj-raw><img src="${escapeHtml(ctx.openPixelUrl)}" width="1" height="1" alt="" style="display:block;border:0" /></mj-raw></mj-column></mj-section>`
    : ""
  const preheader = doc.settings.preheader
    ? `<mj-preview>${plainText(doc.settings.preheader, ctx, missing)}</mj-preview>`
    : ""
  const mjml = `<mjml><mj-head>${preheader}<mj-attributes><mj-all font-family="${FONT_STACKS[doc.settings.fontFamily ?? "system"]}" /></mj-attributes></mj-head><mj-body width="${doc.settings.width ?? 600}px"${doc.settings.background ? ` background-color="${doc.settings.background}"` : ""}>${sections}${pixel}</mj-body></mjml>`
  const { html, errors } = await mjml2html(mjml, { validationLevel: "soft" })
  if (errors.length > 0) {
    throw new Error(
      `mjml render error: ${errors.map((e) => e.formattedMessage).join(", ")}`,
    )
  }
  // No assets in the text part: attachments are MIME parts, not links.
  const textCtx: RenderContext = { ...memoCtx, assets: undefined }
  const textSource = doc.blocks
    .map((block) => blockToHtml(block, textCtx, new Set()))
    .join("\n")
  let text = ""
  try {
    text = htmlToText(textSource, {
      wordwrap: false,
      limits: { maxDepth: 100 },
      selectors: [
        { selector: "img", format: "skip" },
        { selector: "h1", options: { uppercase: false } },
        { selector: "h2", options: { uppercase: false } },
        { selector: "h3", options: { uppercase: false } },
        { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
      ],
    }).trim()
  } catch {
    text = ""
  }
  return {
    html,
    text,
    attachments: attachmentsOf(doc),
    missing: [...missing].sort(),
  }
}
