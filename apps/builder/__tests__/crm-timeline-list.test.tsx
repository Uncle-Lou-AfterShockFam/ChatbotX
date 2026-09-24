// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

/**
 * TimelineList (s195): empty state, one badge + line per row, the deal
 * row is a button that hands the deal id up, kind chips toggle through
 * `onKindsChange`, and "load more" shows only while a cursor exists and
 * nothing is loading.
 */
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}|${JSON.stringify(values)}` : key,
  useFormatter: () => ({ dateTime: (d: Date) => d.toISOString() }),
}))
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode
    href: string
  }) => <a href={href}>{children}</a>,
}))

const { TimelineList } = await import("@/features/crm/components/timeline-list")

const at = new Date("2026-09-24T12:00:00Z")
const page = (rows: unknown[], nextCursor: string | null = null) =>
  ({ data: rows, nextCursor }) as never

describe("TimelineList", () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const render = (props: Partial<Parameters<typeof TimelineList>[0]>) => {
    const base = {
      pages: [],
      loading: false,
      kinds: [],
      onKindsChange: vi.fn(),
      onLoadMore: vi.fn(),
      onOpenDeal: vi.fn(),
      stageNames: new Map([["s1", "New"]]),
    }
    const merged = { ...base, ...props }
    act(() => root.render(<TimelineList {...merged} />))
    return merged
  }

  test("empty + not loading = the empty copy, no rows, no load-more", () => {
    render({ pages: [page([])] })
    expect(container.textContent).toContain("crm.noTimeline")
    expect(
      container.querySelectorAll('[data-testid="crm-timeline-row"]'),
    ).toHaveLength(0)
    expect(container.textContent).not.toContain("crm.loadMore")
  })

  test("rows render a kind badge + copy; a deal row opens the deal; stage ids resolve to names", () => {
    const props = render({
      pages: [
        page([
          {
            kind: "companyNote",
            id: "1",
            at,
            payload: { text: "Called back" },
          },
          {
            kind: "dealActivity",
            id: "2",
            at,
            payload: {
              dealId: "d-1",
              dealTitle: "Roof",
              type: "stageMoved",
              data: { from: "s1", to: "s1" },
            },
          },
          {
            kind: "submission",
            id: "3",
            at,
            payload: { questionnaireName: "Intake", status: "completed" },
          },
        ]),
      ],
    })
    const rows = container.querySelectorAll('[data-testid="crm-timeline-row"]')
    expect(rows).toHaveLength(3)
    expect(rows[0]?.textContent).toContain("crm.kinds.companyNote")
    expect(rows[0]?.textContent).toContain("Called back")
    expect(rows[1]?.textContent).toContain("Roof: ")
    expect(rows[1]?.textContent).toContain('"from":"New"')
    expect(rows[2]?.textContent).toContain(
      'crm.timeline.submission|{"name":"Intake","status":"completed"}',
    )
    const button = rows[1]?.querySelector("button") as HTMLButtonElement
    act(() => button.click())
    expect(props.onOpenDeal).toHaveBeenCalledWith("d-1")
  })

  test("a chip click toggles the kind through onKindsChange (add, then remove)", () => {
    const props = render({ kinds: ["companyNote"] })
    const chips = Array.from(container.querySelectorAll("button[aria-pressed]"))
    const note = chips.find(
      (c) => c.textContent === "crm.kinds.companyNote",
    ) as HTMLButtonElement
    const deal = chips.find(
      (c) => c.textContent === "crm.kinds.dealActivity",
    ) as HTMLButtonElement
    expect(note.getAttribute("aria-pressed")).toBe("true")
    act(() => deal.click())
    expect(props.onKindsChange).toHaveBeenLastCalledWith([
      "companyNote",
      "dealActivity",
    ])
    act(() => note.click())
    expect(props.onKindsChange).toHaveBeenLastCalledWith([])
  })

  test("load-more only with a cursor and not while loading; the click forwards", () => {
    const props = render({
      pages: [
        page(
          [{ kind: "companyNote", id: "1", at, payload: { text: "x" } }],
          "1:1",
        ),
      ],
    })
    const more = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "crm.loadMore",
    ) as HTMLButtonElement
    expect(more).toBeTruthy()
    act(() => more.click())
    expect(props.onLoadMore).toHaveBeenCalledTimes(1)
    render({ ...props, loading: true })
    expect(container.textContent).not.toContain("crm.loadMore")
  })
})
