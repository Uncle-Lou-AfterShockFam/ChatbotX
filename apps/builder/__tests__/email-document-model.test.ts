// @vitest-environment node
import {
  type Block,
  type EmailDocument,
  parseDocument,
} from "@chatbotx.io/email-document"
import { describe, expect, test } from "vitest"
import {
  BLOCK_TYPES,
  blockIdAtPath,
  blocksAt,
  emptyDocument,
  findBlock,
  insertBlock,
  LEAF_TYPES,
  moveBlock,
  newBlock,
  ROOT,
  removeBlock,
  setColumnCount,
  toEditable,
  updateBlock,
} from "@/features/email-templates/lib/document-model"

/** A new block as a user leaves it valid (a new button has no URL yet). */
const make = (type: Block["type"]): Block => {
  const block = newBlock(type, { fileId: "123", html: "<p>imported</p>" })
  return block.type === "button"
    ? { ...block, action: { kind: "url", url: "https://x.test" } }
    : block
}

const withAll = (): EmailDocument =>
  BLOCK_TYPES.reduce(
    (doc, type) => insertBlock(doc, ROOT, make(type)),
    emptyDocument(),
  )

describe("email document model (B2 phase 3)", () => {
  test("the palette is exactly the schema's block types, and every new block parses", () => {
    expect([...BLOCK_TYPES].sort()).toEqual(
      [
        "attachment",
        "button",
        "code",
        "columns",
        "divider",
        "heading",
        "html",
        "image",
        "spacer",
        "text",
      ].sort(),
    )
    const doc = withAll()
    expect(() => parseDocument(doc)).not.toThrow()
    expect(new Set(doc.blocks.map((b) => b.id)).size).toBe(BLOCK_TYPES.length)
  })

  test("skeptic MEDIUM: a new button has NO url, so the preview flags it until one is set", () => {
    const doc = insertBlock(emptyDocument(), ROOT, newBlock("button"))
    expect(() => parseDocument(doc)).toThrow()
  })

  test("skeptic HIGH: a column target that no longer exists resolves to nothing (the editor falls back to the top level)", () => {
    const columns = newBlock("columns")
    let doc = insertBlock(emptyDocument(), ROOT, columns)
    doc = setColumnCount(doc, columns.id, 3)
    const third = { kind: "column" as const, columnsId: columns.id, column: 2 }
    expect(blocksAt(doc, third)).toEqual([])
    doc = setColumnCount(doc, columns.id, 2)
    expect(blocksAt(doc, third)).toBeUndefined()
    expect(blocksAt(removeBlock(doc, columns.id), third)).toBeUndefined()
  })

  test("a media block without a file is refused (it could never be valid)", () => {
    expect(() => newBlock("image")).toThrow()
    expect(() => newBlock("attachment")).toThrow()
  })

  test("an empty draft is NOT a valid document (blocks min 1): the preview reports it", () => {
    expect(() => parseDocument(emptyDocument())).toThrow()
  })

  test("every leaf type can go inside columns and the result parses; columns never nest", () => {
    const columns = newBlock("columns")
    let doc = insertBlock(emptyDocument(), ROOT, columns)
    for (const type of LEAF_TYPES) {
      doc = insertBlock(
        doc,
        { kind: "column", columnsId: columns.id, column: 1 },
        make(type),
      )
    }
    const nested = insertBlock(
      doc,
      { kind: "column", columnsId: columns.id, column: 0 },
      newBlock("columns"),
    )
    expect(nested).toBe(doc)
    const parsed = parseDocument(doc)
    const top = parsed.blocks[0]
    expect(top?.type === "columns" && top.columns[1]?.blocks.length).toBe(
      LEAF_TYPES.length,
    )
  })

  test("move, update and remove address blocks by id at any depth", () => {
    const columns = newBlock("columns")
    const inner = newBlock("text")
    let doc = insertBlock(emptyDocument(), ROOT, newBlock("divider"))
    doc = insertBlock(doc, ROOT, columns)
    doc = insertBlock(
      doc,
      { kind: "column", columnsId: columns.id, column: 0 },
      inner,
    )
    doc = moveBlock(doc, ROOT, 1, 0)
    expect(doc.blocks[0]?.id).toBe(columns.id)
    expect(moveBlock(doc, ROOT, 0, 9).blocks[0]?.id).toBe(columns.id)

    doc = updateBlock(doc, inner.id, { text: "<p>changed</p>" } as never)
    expect(findBlock(doc, inner.id)?.block).toMatchObject({
      text: "<p>changed</p>",
    })
    expect(findBlock(doc, inner.id)?.at).toEqual({
      kind: "column",
      columnsId: columns.id,
      column: 0,
    })
    // An update can never change a block's id or type.
    doc = updateBlock(doc, inner.id, { id: "9", type: "code" } as never)
    expect(findBlock(doc, inner.id)?.block.type).toBe("text")

    doc = removeBlock(doc, inner.id)
    expect(findBlock(doc, inner.id)).toBeUndefined()
    expect(() => parseDocument(doc)).not.toThrow()
  })

  test("going from 3 columns to 2 keeps every block", () => {
    const columns = newBlock("columns")
    let doc = insertBlock(emptyDocument(), ROOT, columns)
    doc = setColumnCount(doc, columns.id, 3)
    doc = insertBlock(
      doc,
      { kind: "column", columnsId: columns.id, column: 2 },
      newBlock("divider"),
    )
    doc = setColumnCount(doc, columns.id, 2)
    const top = doc.blocks[0]
    expect(top?.type === "columns" && top.columns.length).toBe(2)
    expect(top?.type === "columns" && top.columns[1]?.blocks.length).toBe(1)
  })

  test("an issue path maps to the block to highlight (top level and inside columns)", () => {
    const columns = newBlock("columns")
    const inner = newBlock("button")
    let doc = insertBlock(emptyDocument(), ROOT, newBlock("text"))
    doc = insertBlock(doc, ROOT, columns)
    doc = insertBlock(
      doc,
      { kind: "column", columnsId: columns.id, column: 1 },
      inner,
    )
    expect(blockIdAtPath(doc, "blocks.0.text")).toBe(doc.blocks[0]?.id)
    expect(blockIdAtPath(doc, "blocks.1.columns.1.blocks.0.label")).toBe(
      inner.id,
    )
    expect(blockIdAtPath(doc, "blocks.1.columns.1")).toBe(columns.id)
    expect(blockIdAtPath(doc, "settings.width")).toBeUndefined()
    expect(blockIdAtPath(doc, "blocks.99")).toBeUndefined()
    expect(blockIdAtPath(doc, "")).toBeUndefined()
  })

  test("toEditable keeps a stored document and turns junk into an empty draft", () => {
    const doc = withAll()
    expect(toEditable(doc)).toBe(doc)
    for (const junk of [null, "x", 42, {}, { blocks: "x", settings: {} }]) {
      expect(toEditable(junk)).toEqual(emptyDocument())
    }
  })

  test("property: any sequence of edits yields a document that parses (when non-empty)", () => {
    let seed = 5
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
      return seed % n
    }
    for (let run = 0; run < 30; run++) {
      let doc = emptyDocument()
      for (let step = 0; step < 25; step++) {
        const ids = doc.blocks.map((b) => b.id)
        const columnsIds = doc.blocks
          .filter((b) => b.type === "columns")
          .map((b) => b.id)
        switch (rand(5)) {
          case 0:
          case 1: {
            const type = BLOCK_TYPES[rand(BLOCK_TYPES.length)] as Block["type"]
            const target =
              columnsIds.length > 0 && rand(2) === 0
                ? {
                    kind: "column" as const,
                    columnsId: columnsIds[rand(columnsIds.length)] as string,
                    column: rand(2),
                  }
                : ROOT
            doc = insertBlock(doc, target, make(type))
            break
          }
          case 2:
            doc = moveBlock(doc, ROOT, rand(ids.length + 1), rand(ids.length))
            break
          case 3:
            if (ids.length > 0) {
              doc = removeBlock(doc, ids[rand(ids.length)] as string)
            }
            break
          default:
            if (columnsIds.length > 0) {
              doc = setColumnCount(
                doc,
                columnsIds[0] as string,
                rand(2) === 0 ? 2 : 3,
              )
            }
        }
      }
      if (doc.blocks.length > 0) {
        expect(() => parseDocument(doc)).not.toThrow()
      }
    }
  })
})
