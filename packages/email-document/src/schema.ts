import { z } from "zod"

/**
 * The B2 email document (v1), the contract in bulktext
 * `docs/B2-DOCUMENT-SCHEMA.md`. CLOSED at every level (`.strict()`): an
 * unknown key is a validation error, never silently dropped. Lane A's B4
 * pages render the same documents through `renderWeb`; never fork this.
 */

export const DOCUMENT_VERSION = 1
/** Serialized-size cap (bytes of JSON) checked by `parseDocument`. */
export const MAX_DOCUMENT_BYTES = 256 * 1024
export const MAX_TOP_LEVEL_BLOCKS = 200
export const MAX_COLUMN_BLOCKS = 20
export const MAX_RICH_TEXT_LENGTH = 20 * 1024
export const MAX_HTML_BLOCK_LENGTH = 50 * 1024

const blockId = z.string().regex(/^\d{1,20}$/, "a snowflake id")
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a #rrggbb color")
const align = z.enum(["left", "center", "right"])
export const fontFamilies = z.enum([
  "system",
  "arial",
  "georgia",
  "helvetica",
  "times",
  "verdana",
])

/** http(s), mailto, or a string that is exactly one merge token. */
const SAFE_SCHEME = /^(https?:\/\/|mailto:)/i
const TOKEN_ONLY = /^\{\{\s*[a-zA-Z0-9_.]+(\|[^}]*)?\s*\}\}$/
export const linkSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (value) => SAFE_SCHEME.test(value) || TOKEN_ONLY.test(value),
    "only http(s), mailto: or a single merge token",
  )

export const assetRefSchema = z
  .object({ kind: z.literal("media"), fileId: blockId })
  .strict()

const richText = z.string().max(MAX_RICH_TEXT_LENGTH)

export const buttonActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: linkSchema }).strict(),
  z
    .object({
      kind: z.literal("flow"),
      // The flow-config button step payload (applyTag, startExternalFlow...),
      // validated by the email step / page that executes it, not here.
      beforeStep: z.record(z.string(), z.unknown()),
      steps: z.array(z.record(z.string(), z.unknown())).max(20),
    })
    .strict(),
])

const headingBlock = z
  .object({
    id: blockId,
    type: z.literal("heading"),
    text: richText,
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    align: align.optional(),
  })
  .strict()
const textBlock = z
  .object({
    id: blockId,
    type: z.literal("text"),
    text: richText,
    align: align.optional(),
  })
  .strict()
const imageBlock = z
  .object({
    id: blockId,
    type: z.literal("image"),
    src: z.union([assetRefSchema, linkSchema]),
    alt: z.string().max(200),
    href: linkSchema.optional(),
    width: z.number().int().min(1).max(800).optional(),
  })
  .strict()
const buttonBlock = z
  .object({
    id: blockId,
    type: z.literal("button"),
    label: z.string().trim().min(1).max(40),
    action: buttonActionSchema,
    align: align.optional(),
    color: hexColor.optional(),
  })
  .strict()
const dividerBlock = z
  .object({ id: blockId, type: z.literal("divider") })
  .strict()
const spacerBlock = z
  .object({
    id: blockId,
    type: z.literal("spacer"),
    height: z.number().int().min(4).max(96),
  })
  .strict()
const htmlBlock = z
  .object({
    id: blockId,
    type: z.literal("html"),
    html: z.string().max(MAX_HTML_BLOCK_LENGTH),
  })
  .strict()
const attachmentBlock = z
  .object({ id: blockId, type: z.literal("attachment"), asset: assetRefSchema })
  .strict()
const codeBlock = z
  .object({
    id: blockId,
    type: z.literal("code"),
    text: z.string().max(MAX_RICH_TEXT_LENGTH),
  })
  .strict()

/** Every block except `columns`: nesting depth is capped at 2 by construction. */
export const leafBlockSchema = z.discriminatedUnion("type", [
  headingBlock,
  textBlock,
  imageBlock,
  buttonBlock,
  dividerBlock,
  spacerBlock,
  htmlBlock,
  attachmentBlock,
  codeBlock,
])

const columnsBlock = z
  .object({
    id: blockId,
    type: z.literal("columns"),
    columns: z
      .array(
        z
          .object({ blocks: z.array(leafBlockSchema).max(MAX_COLUMN_BLOCKS) })
          .strict(),
      )
      .min(2)
      .max(3),
  })
  .strict()

export const blockSchema = z.discriminatedUnion("type", [
  headingBlock,
  textBlock,
  imageBlock,
  buttonBlock,
  dividerBlock,
  spacerBlock,
  htmlBlock,
  attachmentBlock,
  codeBlock,
  columnsBlock,
])

export const emailDocumentSchema = z
  .object({
    version: z.literal(DOCUMENT_VERSION),
    settings: z
      .object({
        width: z.number().int().min(480).max(800).optional(),
        background: hexColor.optional(),
        fontFamily: fontFamilies.optional(),
        preheader: z.string().max(150).optional(),
      })
      .strict(),
    blocks: z.array(blockSchema).min(1).max(MAX_TOP_LEVEL_BLOCKS),
  })
  .strict()

export type EmailDocument = z.infer<typeof emailDocumentSchema>
export type Block = z.infer<typeof blockSchema>
export type LeafBlock = z.infer<typeof leafBlockSchema>
export type AssetRef = z.infer<typeof assetRefSchema>
export type ButtonAction = z.infer<typeof buttonActionSchema>
