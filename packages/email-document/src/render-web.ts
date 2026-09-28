import {
  assertLeaf,
  plainText,
  prepareRich,
  type RenderContext,
  resolveButtonHref,
  resolveSrc,
  resolveTemplateUrl,
} from "./context"
import { parseDocument } from "./parse"
import type { Block, EmailDocument, LeafBlock } from "./schema"
import { escapeHtml } from "./tokens"

export type { RenderAsset, RenderContext } from "./context"

const FONT_STACKS: Record<string, string> = {
  system: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
  arial: "Arial,Helvetica,sans-serif",
  georgia: "Georgia,serif",
  helvetica: "Helvetica,Arial,sans-serif",
  times: "'Times New Roman',Times,serif",
  verdana: "Verdana,Geneva,sans-serif",
}

function leafToHtml(
  block: LeafBlock,
  ctx: RenderContext,
  missing: Set<string>,
): string {
  const alignStyle = (align?: string) =>
    align ? ` style="text-align:${align}"` : ""
  switch (block.type) {
    case "heading":
      return `<h${block.level} data-block="${block.id}"${alignStyle(block.align)}>${prepareRich(block.text, block.id, ctx, missing, "rich")}</h${block.level}>`
    case "text":
      return `<div data-block="${block.id}"${alignStyle(block.align)}>${prepareRich(block.text, block.id, ctx, missing, "rich")}</div>`
    case "code":
      return `<pre data-block="${block.id}"><code>${plainText(block.text, ctx, missing)}</code></pre>`
    case "image": {
      const src = resolveSrc(block.src, ctx, missing)
      if (!src) {
        return ""
      }
      const width = block.width ? ` width="${block.width}"` : ""
      const img = `<img src="${escapeHtml(src)}" alt="${plainText(block.alt, ctx, missing)}"${width} style="max-width:100%;height:auto">`
      const href = block.href
        ? resolveTemplateUrl(block.href, block.id, ctx, missing)
        : ""
      return `<figure data-block="${block.id}">${href ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank">${img}</a>` : img}</figure>`
    }
    case "button": {
      const href = resolveButtonHref(block, ctx, missing)
      if (!href) {
        return ""
      }
      const color = block.color ?? "#111111"
      return `<p data-block="${block.id}"${alignStyle(block.align)}><a href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank" style="display:inline-block;padding:10px 18px;border-radius:4px;background:${color};color:#ffffff;text-decoration:none;font-weight:700">${plainText(block.label, ctx, missing)}</a></p>`
    }
    case "divider":
      return `<hr data-block="${block.id}">`
    case "spacer":
      return `<div data-block="${block.id}" style="height:${block.height}px"></div>`
    case "html":
      return `<div data-block="${block.id}">${prepareRich(block.html, block.id, ctx, missing, "html")}</div>`
    case "attachment": {
      const asset = ctx.assets?.[block.asset.fileId]
      if (!asset) {
        missing.add(`asset:${block.asset.fileId}`)
        return ""
      }
      return `<p data-block="${block.id}"><a href="${escapeHtml(asset.url)}" rel="noopener noreferrer" download>${escapeHtml(asset.name)}</a></p>`
    }
    default:
      return ""
  }
}

/** One block as HTML with `ctx` as given (the email text part reuses it). */
export function blockToHtml(
  block: Block,
  ctx: RenderContext,
  missing: Set<string>,
): string {
  if (block.type !== "columns") {
    return leafToHtml(block, ctx, missing)
  }
  const cells = block.columns
    .map(
      (column) =>
        `<div style="flex:1 1 0;min-width:0">${column.blocks.map((leaf) => leafToHtml(assertLeaf(leaf), ctx, missing)).join("")}</div>`,
    )
    .join("")
  return `<div data-block="${block.id}" style="display:flex;gap:16px;flex-wrap:wrap">${cells}</div>`
}

/**
 * Sanitized HTML for a web page (lane A's B4 pages). Pure: same document +
 * context -> same bytes; no pixel, no unsubscribe, attachments become links.
 */
export function renderWeb(
  input: EmailDocument | unknown,
  ctx: RenderContext,
): { html: string; missing: string[] } {
  const doc = parseDocument(input)
  const missing = new Set<string>()
  const webCtx: RenderContext = {
    ...ctx,
    openPixelUrl: undefined,
    unsubscribeUrl: undefined,
  }
  const font = FONT_STACKS[doc.settings.fontFamily ?? "system"]
  const body = doc.blocks
    .map((block) => blockToHtml(block, webCtx, missing))
    .join("\n")
  const background = doc.settings.background
    ? `background:${doc.settings.background};`
    : ""
  return {
    html: `<div class="email-document" style="max-width:${doc.settings.width ?? 600}px;margin:0 auto;font-family:${font};${background}">\n${body}\n</div>`,
    missing: [...missing].sort(),
  }
}
