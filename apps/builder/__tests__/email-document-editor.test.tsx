import { type EmailDocument, parseDocument } from "@chatbotx.io/email-document"
import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const { preview } = vi.hoisted(() => ({ preview: { current: {} as object } }))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock("@/features/email-templates/provider/email-template-hooks", () => ({
  useEmailTemplatePreview: () => preview.current,
  useFlowOptions: () => ({ data: [] }),
}))
// The picker is a dialog over the media API: stand in with a button that
// "picks" file 77 when clicked.
vi.mock("@/features/media-library/components/media-library-trigger", () => ({
  MediaLibraryTrigger: ({
    children,
    onSelect,
  }: {
    children: React.ReactElement<{ "data-testid"?: string }>
    onSelect: (file: object) => void
  }) => (
    <button
      data-testid={children.props["data-testid"]}
      onClick={() =>
        onSelect({
          id: "77",
          url: "https://cdn.test/a.pdf",
          name: "a.pdf",
          mimeType: "application/pdf",
        })
      }
      type="button"
    >
      pick
    </button>
  ),
}))
vi.mock("@/features/email-templates/components/rich-text-field", () => ({
  RichTextField: () => <div data-testid="richtext" />,
}))

const { EmailDocumentEditor } = await import(
  "@/features/email-templates/components/email-document-editor"
)
const { emptyDocument } = await import(
  "@/features/email-templates/lib/document-model"
)

let container: HTMLDivElement | null = null
let root: Root | null = null
let latest: EmailDocument = emptyDocument()

function Harness({ initial }: { initial: EmailDocument }) {
  const [doc, setDoc] = useState(initial)
  latest = doc
  return (
    <EmailDocumentEditor
      onChange={(next) => {
        latest = next
        setDoc(next)
      }}
      value={doc}
      workspaceId="1"
    />
  )
}

function mount(initial = emptyDocument()) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<Harness initial={initial} />)
  })
  return container
}

const click = (el: Element | null | undefined) => {
  expect(el).toBeTruthy()
  act(() => {
    ;(el as HTMLElement).click()
  })
}

beforeEach(() => {
  preview.current = {}
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe("EmailDocumentEditor (B2 phase 3)", () => {
  test("palette blocks land in the document, which parses; media blocks carry the picked file", () => {
    const el = mount()
    for (const type of ["heading", "text", "button", "divider", "attachment"]) {
      click(el.querySelector(`[data-testid="email-add-${type}"]`))
    }
    expect(latest.blocks.map((b) => b.type)).toEqual([
      "heading",
      "text",
      "button",
      "divider",
      "attachment",
    ])
    expect(latest.blocks[4]).toMatchObject({
      asset: { kind: "media", fileId: "77" },
    })
    expect(() => parseDocument(latest)).not.toThrow()
    // The canvas names the attachment by its picked file, not its id.
    expect(el.textContent).toContain("a.pdf")
  })

  test("a column target sends new blocks into that column, and never a nested columns block", () => {
    const el = mount()
    click(el.querySelector('[data-testid="email-add-columns"]'))
    click(el.querySelector('[data-testid="email-column-target-1"]'))
    expect(el.querySelector('[data-testid="email-add-columns"]')).toBeNull()
    click(el.querySelector('[data-testid="email-add-text"]'))
    const top = latest.blocks[0]
    expect(top?.type).toBe("columns")
    expect(top?.type === "columns" && top.columns[1]?.blocks[0]?.type).toBe(
      "text",
    )
    expect(() => parseDocument(latest)).not.toThrow()
  })

  test("preview issues outline the offending block and are listed", () => {
    const start = {
      version: 1 as const,
      settings: {},
      blocks: [{ id: "5", type: "divider" as const }],
    }
    preview.current = {
      data: { ok: false, issues: [{ path: "blocks.0", message: "bad block" }] },
    }
    const el = mount(start)
    expect(
      el.querySelector('[data-testid="email-preview-issues"]')?.textContent,
    ).toContain("bad block")
    expect(
      el.querySelector('[data-testid="email-block-divider"]')?.className,
    ).toContain("border-destructive")
    expect(el.querySelector('[data-testid="email-preview-frame"]')).toBeNull()
  })

  test("a rendered preview is shown in a fully sandboxed iframe", () => {
    preview.current = {
      data: {
        ok: true,
        html: "<p>hi</p><script>parent.x=1</script>",
        text: "hi",
        missing: [],
        assets: {},
      },
    }
    const el = mount({
      version: 1,
      settings: {},
      blocks: [{ id: "5", type: "divider" }],
    })
    const frame = el.querySelector('[data-testid="email-preview-frame"]')
    expect(frame?.getAttribute("sandbox")).toBe("")
  })

  test("removing a selected block clears the inspector", () => {
    const el = mount()
    click(el.querySelector('[data-testid="email-add-spacer"]'))
    expect(
      el.querySelector('[data-testid="email-block-inspector"]'),
    ).toBeTruthy()
    click(el.querySelector('[aria-label="removeBlock"]'))
    expect(latest.blocks).toEqual([])
    expect(el.querySelector('[data-testid="email-block-inspector"]')).toBeNull()
  })
})
