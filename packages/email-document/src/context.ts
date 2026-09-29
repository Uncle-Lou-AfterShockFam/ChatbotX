import { DocumentDepthError } from "./errors"
import { sanitizeHtmlBlock, sanitizeRichText } from "./sanitize"
import type { AssetRef, Block, EmailDocument, LeafBlock } from "./schema"
import {
  escapeHtml,
  mergeHtml,
  mergeText,
  mergeUrl,
  type TokenVars,
} from "./tokens"

export type RenderAsset = {
  url: string
  name: string
  size: number
  mimeType: string
}

/** Everything a renderer needs; resolved by the caller. Renderers never fetch. */
export type RenderContext = {
  vars: TokenVars
  assets?: Readonly<Record<string, RenderAsset>>
  /** Click-tracking rewrite for a TEMPLATE link (never a merged value). */
  link?: (url: string, blockId: string) => string
  /** A flow-action button's signed click URL. */
  button?: (blockId: string) => string
  /** Email only: replaces `<<unsubscribeUrl>>`. */
  unsubscribeUrl?: string
  /** Email only. */
  openPixelUrl?: string
}

export const UNSUBSCRIBE_PLACEHOLDER = "<<unsubscribeUrl>>"
const UNSUBSCRIBE_SENTINEL = "__UNSUBSCRIBE_URL__"
const HAS_TOKEN = /\{\{/
const HTTP_URL = /^https?:\/\//i
const AMP_ENTITY = /&amp;/g
const HTTP_HREF = /(\shref=")(https?:\/\/[^"]*)(")/gi

/**
 * Sanitize -> track template links -> merge tokens (values escaped) ->
 * unsubscribe placeholder. Tracking runs BEFORE merging so a URL that
 * arrives inside a contact's value is never handed to `link`.
 */
export function prepareRich(
  raw: string,
  blockId: string,
  ctx: RenderContext,
  missing: Set<string>,
  kind: "rich" | "html",
): string {
  const withPlaceholder = raw.replaceAll(
    UNSUBSCRIBE_PLACEHOLDER,
    "__UNSUBSCRIBE_URL__",
  )
  let html =
    kind === "rich"
      ? sanitizeRichText(withPlaceholder)
      : sanitizeHtmlBlock(withPlaceholder)
  if (ctx.link) {
    const link = ctx.link
    html = html.replace(
      HTTP_HREF,
      (_m, open: string, href: string, close: string) =>
        HAS_TOKEN.test(href)
          ? `${open}${href}${close}`
          : `${open}${escapeHtml(link(href.replace(AMP_ENTITY, "&"), blockId))}${close}`,
    )
  }
  // The sentinel is swapped BEFORE merging: a contact value that happens to
  // contain it is merged afterwards and stays inert text.
  html = html.replaceAll(
    UNSUBSCRIBE_SENTINEL,
    ctx.unsubscribeUrl ? escapeHtml(ctx.unsubscribeUrl) : "#",
  )
  return mergeHtml(html, ctx.vars, missing)
}

/**
 * An asset URL from the caller's `assets` map, admitted only as http(s): the
 * same scheme rule every other URL path enforces, so a bad asset record can
 * never put `javascript:` into a public page's href/src.
 */
export function safeAssetUrl(
  fileId: string,
  ctx: RenderContext,
  missing: Set<string>,
): RenderAsset | undefined {
  const asset = ctx.assets?.[fileId]
  if (
    !(asset && typeof asset.url === "string" && HTTP_URL.test(asset.url.trim()))
  ) {
    missing.add(`asset:${fileId}`)
    return
  }
  return asset
}

export function resolveSrc(
  src: AssetRef | string,
  ctx: RenderContext,
  missing: Set<string>,
): string {
  if (typeof src !== "string") {
    return safeAssetUrl(src.fileId, ctx, missing)?.url.trim() ?? ""
  }
  return mergeUrl(src, ctx.vars, missing)
}

/** A template URL: tracked only when it is literal (no token), then merged. */
export function resolveTemplateUrl(
  template: string,
  blockId: string,
  ctx: RenderContext,
  missing: Set<string>,
): string {
  const tracked =
    ctx.link && !HAS_TOKEN.test(template)
      ? ctx.link(template, blockId)
      : template
  return mergeUrl(tracked, ctx.vars, missing)
}

export function resolveButtonHref(
  block: Extract<LeafBlock, { type: "button" }>,
  ctx: RenderContext,
  missing: Set<string>,
): string {
  if (block.action.kind === "flow") {
    // The caller's resolved URL gets the same scheme rule as every other
    // href: an openWebsite step's beforeStep.url of javascript: never lands.
    const url = ctx.button ? ctx.button(block.id).trim() : ""
    return HTTP_URL.test(url) ? url : ""
  }
  return resolveTemplateUrl(block.action.url, block.id, ctx, missing)
}

export function plainText(
  value: string,
  ctx: RenderContext,
  missing: Set<string>,
) {
  return mergeText(escapeHtml(value), ctx.vars, missing)
}

/** Depth guard: columns never nest (schema) - asserted here too. */
export function assertLeaf(block: Block): LeafBlock {
  if (block.type === "columns") {
    throw new DocumentDepthError()
  }
  return block
}

export function attachmentsOf(doc: EmailDocument): AssetRef[] {
  const out: AssetRef[] = []
  for (const block of doc.blocks) {
    const leaves =
      block.type === "columns"
        ? block.columns.flatMap((column) => column.blocks)
        : [block]
    for (const leaf of leaves) {
      if (leaf.type === "attachment") {
        out.push(leaf.asset)
      }
    }
  }
  return out
}
