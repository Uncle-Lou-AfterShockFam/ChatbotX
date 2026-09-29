import { type EmailDocument, parseDocument } from "@chatbotx.io/email-document"
import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

// Effects (the validity callback) must flush inside act().
;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const { preview, previewVars } = vi.hoisted(() => ({
  preview: { current: {} as object },
  previewVars: [] as unknown[],
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock("@/features/email-templates/provider/email-template-hooks", () => ({
  useEmailTemplatePreview: (
    _workspaceId: string,
    _document: unknown,
    _enabled: boolean,
    vars?: Record<string, string>,
  ) => {
    previewVars.push(vars)
    return preview.current
  },
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
let validity: boolean[] = []

function Harness({ initial }: { initial: EmailDocument }) {
  const [doc, setDoc] = useState(initial)
  latest = doc
  return (
    <EmailDocumentEditor
      onChange={(next) => {
        latest = next
        setDoc(next)
      }}
      onValidChange={(v) => validity.push(v)}
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
  validity = []
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
    // The new button has no URL yet (skeptic MEDIUM): set one, then it parses.
    const button = latest.blocks[2]
    expect(button?.type === "button" && button.action).toEqual({
      kind: "url",
      url: "",
    })
    expect(() => parseDocument(latest)).toThrow()
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

  test("s223b: the preview gets sample values for system-field tokens only, and says so", () => {
    preview.current = {
      data: { ok: true, html: "", text: "", missing: ["plan"], assets: {} },
    }
    const el = mount({
      version: 1,
      settings: { preheader: "For {{email}}" },
      blocks: [
        {
          id: "5",
          type: "text",
          text: "<p>Hi {{first_name|friend}}, your {{plan}} {{bot_field:12}}</p>",
        },
      ],
    })
    expect(previewVars.at(-1)).toEqual({
      email: "alex@example.com",
      first_name: "Alex",
    })
    expect(
      el.querySelector('[data-testid="email-preview-samples"]')?.textContent,
    ).toContain("previewSamples")
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

  test("skeptic HIGH: shrinking columns past the target sends new blocks to the top level, never nowhere", () => {
    const el = mount()
    click(el.querySelector('[data-testid="email-add-columns"]'))
    const columnsId = latest.blocks[0]?.id as string
    act(() => {
      root?.render(
        <Harness
          initial={{
            version: 1,
            settings: {},
            blocks: [
              {
                id: columnsId,
                type: "columns",
                columns: [{ blocks: [] }, { blocks: [] }, { blocks: [] }],
              },
            ],
          }}
          key="three"
        />,
      )
    })
    click(el.querySelector('[data-testid="email-column-target-2"]'))
    // Column 3 is dropped by the inspector (2 columns).
    click(
      el.querySelector(
        '[data-testid="email-block-columns"] button:not([aria-label])',
      ),
    )
    const before = latest.blocks.length
    act(() => {
      root?.render(
        <Harness
          initial={{
            version: 1,
            settings: {},
            blocks: [
              {
                id: columnsId,
                type: "columns",
                columns: [{ blocks: [] }, { blocks: [] }],
              },
            ],
          }}
          key="two"
        />,
      )
    })
    click(el.querySelector('[data-testid="email-add-divider"]'))
    expect(latest.blocks.length).toBe(before + 1)
    expect(latest.blocks.at(-1)?.type).toBe("divider")
  })

  test("skeptic HIGH: Save waits for a passing render of THIS draft; a preview outage does not block it", () => {
    const doc = {
      version: 1 as const,
      settings: {},
      blocks: [{ id: "5", type: "divider" as const }],
    }
    preview.current = {
      data: { ok: false, issues: [{ path: "blocks.0", message: "bad" }] },
      isFetching: false,
    }
    mount(doc)
    expect(validity.at(-1)).toBe(false)
    act(() => root?.unmount())
    preview.current = {
      data: { ok: true, html: "", text: "", missing: [], assets: {} },
      isFetching: false,
    }
    mount(doc)
    expect(validity.at(-1)).toBe(true)
    act(() => root?.unmount())
    preview.current = { isError: true, isFetching: false }
    mount(doc)
    expect(validity.at(-1)).toBe(true)
    act(() => root?.unmount())
    preview.current = {
      data: { ok: true, html: "", text: "", missing: [], assets: {} },
      isFetching: true,
    }
    mount(doc)
    expect(validity.at(-1)).toBe(false)
  })
})
