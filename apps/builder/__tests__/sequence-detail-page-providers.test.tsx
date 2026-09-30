import { describe, expect, test, vi } from "vitest"

vi.mock("@/features/sequences/queries", () => ({
  getSequence: vi.fn(async () => ({ id: "11", steps: [] })),
}))
vi.mock("@/features/sequences/sequence-editor", () => ({
  SequenceEditor: () => null,
}))

const { CustomFieldStoreProvider } = await import(
  "@/features/custom-fields/provider/custom-field-store-context"
)
const { SequenceEditor } = await import("@/features/sequences/sequence-editor")
const { default: SequenceDetailPage } = await import(
  "@/app/space/[workspaceId]/sequences/[id]/page"
)

type El = { type: unknown; props: { children?: unknown } }

/** The chain of element types from the root down to `target`, or null. */
function pathTo(node: unknown, target: unknown): unknown[] | null {
  if (node === null || typeof node !== "object") {
    return null
  }
  const el = node as El
  if (el.type === target) {
    return [el.type]
  }
  const children = Array.isArray(el.props?.children)
    ? el.props.children
    : [el.props?.children]
  for (const child of children) {
    const below = pathTo(child, target)
    if (below) {
      return [el.type, ...below]
    }
  }
  return null
}

describe("sequence detail page (s228b regression)", () => {
  test("the editor renders inside a CustomFieldStoreProvider (the step card's hold field needs it)", async () => {
    const tree = await SequenceDetailPage({
      params: Promise.resolve({
        workspaceId: "11701868563365888",
        id: "11715121522458624",
      }),
      searchParams: Promise.resolve({}),
    })
    const path = pathTo(tree, SequenceEditor)
    expect(path).not.toBeNull()
    expect(path).toContain(CustomFieldStoreProvider)
  })
})
