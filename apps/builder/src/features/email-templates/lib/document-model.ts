import type {
  Block,
  EmailDocument,
  LeafBlock,
} from "@chatbotx.io/email-document"
import { createId } from "@chatbotx.io/utils"

/**
 * Pure editing operations over an EmailDocument v1 (B2 phase 3). The editor
 * never builds JSON by hand: every change goes through these, so a saved
 * document is always the closed schema's shape (the service re-validates).
 * Blocks are addressed by id; a leaf inside `columns` is addressed by the
 * same id (ids are unique across the whole document).
 */

export type BlockType = Block["type"]
export type LeafType = LeafBlock["type"]

/** The palette, in display order: exactly the schema's block types. */
export const BLOCK_TYPES = [
  "heading",
  "text",
  "image",
  "button",
  "divider",
  "spacer",
  "columns",
  "html",
  "attachment",
  "code",
] as const satisfies readonly BlockType[]

export const LEAF_TYPES = BLOCK_TYPES.filter(
  (type): type is LeafType => type !== "columns",
)

/** Where a block lives: top level, or column `column` of a columns block. */
export type Container =
  | { kind: "root" }
  | { kind: "column"; columnsId: string; column: number }

export const ROOT: Container = { kind: "root" }

export function emptyDocument(): EmailDocument {
  return { version: 1, settings: {}, blocks: [] as unknown as Block[] }
}

/**
 * A new block with valid defaults. The media blocks carry the file picked in
 * the palette: without one they would not be valid, so that is a caller bug.
 */
export function newBlock(
  type: BlockType,
  extra: { fileId?: string; html?: string } = {},
): Block {
  const id = createId()
  const { fileId, html } = extra
  if ((type === "image" || type === "attachment") && !fileId) {
    throw new Error(`a new ${type} block needs a media file`)
  }
  switch (type) {
    case "heading":
      return { id, type, level: 2, text: "<p>Heading</p>" }
    case "text":
      return { id, type, text: "<p></p>" }
    case "image":
      return {
        id,
        type,
        src: { kind: "media", fileId: fileId as string },
        alt: "",
      }
    case "button":
      return {
        id,
        type,
        label: "Learn more",
        action: { kind: "url", url: "https://" },
      }
    case "divider":
      return { id, type }
    case "spacer":
      return { id, type, height: 24 }
    case "columns":
      return { id, type, columns: [{ blocks: [] }, { blocks: [] }] }
    case "html":
      return { id, type, html: html ?? "" }
    case "attachment":
      return { id, type, asset: { kind: "media", fileId: fileId as string } }
    case "code":
      return { id, type, text: "" }
    default: {
      const never: never = type
      throw new Error(`unknown block type ${String(never)}`)
    }
  }
}

export function blocksAt(
  doc: EmailDocument,
  at: Container,
): Block[] | undefined {
  if (at.kind === "root") {
    return doc.blocks
  }
  const parent = doc.blocks.find((b) => b.id === at.columnsId)
  if (parent?.type !== "columns") {
    return
  }
  return parent.columns[at.column]?.blocks
}

/** Replace the list at `at` (immutably); an unknown container is a no-op. */
function withBlocksAt(
  doc: EmailDocument,
  at: Container,
  update: (blocks: Block[]) => Block[],
): EmailDocument {
  if (at.kind === "root") {
    return { ...doc, blocks: update(doc.blocks) }
  }
  return {
    ...doc,
    blocks: doc.blocks.map((b) =>
      b.id === at.columnsId && b.type === "columns"
        ? {
            ...b,
            columns: b.columns.map((col, i) =>
              i === at.column
                ? { blocks: update(col.blocks) as LeafBlock[] }
                : col,
            ),
          }
        : b,
    ),
  }
}

/** Append (or insert at `index`); a `columns` block never nests. */
export function insertBlock(
  doc: EmailDocument,
  at: Container,
  block: Block,
  index?: number,
): EmailDocument {
  if (at.kind === "column" && block.type === "columns") {
    return doc
  }
  return withBlocksAt(doc, at, (blocks) => {
    const next = [...blocks]
    next.splice(index ?? next.length, 0, block)
    return next
  })
}

export function moveBlock(
  doc: EmailDocument,
  at: Container,
  from: number,
  to: number,
): EmailDocument {
  return withBlocksAt(doc, at, (blocks) => {
    if (from < 0 || from >= blocks.length || to < 0 || to >= blocks.length) {
      return blocks
    }
    const next = [...blocks]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved as Block)
    return next
  })
}

/** Remove a block wherever it is (root or inside columns). */
export function removeBlock(doc: EmailDocument, id: string): EmailDocument {
  return {
    ...doc,
    blocks: doc.blocks
      .filter((b) => b.id !== id)
      .map((b) =>
        b.type === "columns"
          ? {
              ...b,
              columns: b.columns.map((col) => ({
                blocks: col.blocks.filter((leaf) => leaf.id !== id),
              })),
            }
          : b,
      ),
  }
}

/** Shallow-merge `patch` into the block with `id`, wherever it is. */
export function updateBlock(
  doc: EmailDocument,
  id: string,
  patch: Partial<Block>,
): EmailDocument {
  const apply = <T extends Block>(b: T): T =>
    b.id === id ? ({ ...b, ...patch, id: b.id, type: b.type } as T) : b
  return {
    ...doc,
    blocks: doc.blocks.map((b) => {
      const next = apply(b)
      return next.type === "columns"
        ? {
            ...next,
            columns: next.columns.map((col) => ({
              blocks: col.blocks.map(apply),
            })),
          }
        : next
    }),
  }
}

export function findBlock(
  doc: EmailDocument,
  id: string,
): { block: Block; at: Container; index: number } | undefined {
  for (const [index, b] of doc.blocks.entries()) {
    if (b.id === id) {
      return { block: b, at: ROOT, index }
    }
    if (b.type === "columns") {
      for (const [column, col] of b.columns.entries()) {
        const leafIndex = col.blocks.findIndex((leaf) => leaf.id === id)
        if (leafIndex >= 0) {
          return {
            block: col.blocks[leafIndex] as Block,
            at: { kind: "column", columnsId: b.id, column },
            index: leafIndex,
          }
        }
      }
    }
  }
}

/** Resize a columns block to 2 or 3 columns; dropped columns' blocks move to the last kept one. */
export function setColumnCount(
  doc: EmailDocument,
  columnsId: string,
  count: 2 | 3,
): EmailDocument {
  return {
    ...doc,
    blocks: doc.blocks.map((b) => {
      if (b.id !== columnsId || b.type !== "columns") {
        return b
      }
      if (count === 3) {
        return b.columns.length >= 3
          ? b
          : { ...b, columns: [...b.columns, { blocks: [] }] }
      }
      const [first, second, ...rest] = b.columns
      return {
        ...b,
        columns: [
          first ?? { blocks: [] },
          {
            blocks: [
              ...(second?.blocks ?? []),
              ...rest.flatMap((c) => c.blocks),
            ],
          },
        ],
      }
    }),
  }
}

/**
 * The block a schema issue path points at (`blocks.3.text`,
 * `blocks.1.columns.0.blocks.2.label`), for highlighting it in the canvas.
 */
export function blockIdAtPath(
  doc: EmailDocument,
  path: string,
): string | undefined {
  const parts = path.split(".")
  if (parts[0] !== "blocks") {
    return
  }
  const top = doc.blocks[Number(parts[1])]
  if (!top) {
    return
  }
  if (
    top.type === "columns" &&
    parts[2] === "columns" &&
    parts[4] === "blocks"
  ) {
    return top.columns[Number(parts[3])]?.blocks[Number(parts[5])]?.id ?? top.id
  }
  return top.id
}

/** The document the editor starts from: a stored one, or an empty draft. */
export function toEditable(value: unknown): EmailDocument {
  if (
    value !== null &&
    typeof value === "object" &&
    Array.isArray((value as EmailDocument).blocks) &&
    typeof (value as EmailDocument).settings === "object"
  ) {
    return value as EmailDocument
  }
  return emptyDocument()
}
