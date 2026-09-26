import type { ComponentProps, ReactNode } from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: ReactNode
    href: string
    className?: string
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const { AppTab } = await import("@/components/app-tab")

type Tab = ComponentProps<typeof AppTab>["tabs"][number]

type Span = { left: number; right: number }

/**
 * jsdom lays nothing out. The strip and its active tab report the given
 * on-screen spans; a spy, not a prototype write, so `mockRestore` puts
 * jsdom's own getter back.
 */
function stubRects(strip: Span, active: Span) {
  return vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const span = this.getAttribute("aria-current") === "page" ? active : strip
      return DOMRect.fromRect({
        x: span.left,
        y: 0,
        width: span.right - span.left,
        height: 40,
      })
    })
}

const TABS: Tab[] = [
  { label: "General", href: "/settings/general", isActive: true },
  { label: "Channels", href: "/settings/channels", isActive: false },
  { label: "Integrations", href: "/settings/integrations", isActive: false },
  { label: "Admins", href: "/settings/admins", isActive: false },
  { label: "Inbox teams", href: "/settings/inbox-teams", isActive: false },
]

describe("AppTab", () => {
  let container: HTMLDivElement
  let root: Root

  const render = (tabs: Tab[]) => {
    act(() => {
      root.render(<AppTab tabs={tabs} />)
    })
  }

  const strip = () => {
    const anchor = container.querySelector("a")
    return anchor?.parentElement ?? null
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  test("renders every tab", () => {
    render(TABS)

    const labels = Array.from(container.querySelectorAll("a")).map(
      (anchor) => anchor.textContent,
    )
    expect(labels).toEqual([
      "General",
      "Channels",
      "Integrations",
      "Admins",
      "Inbox teams",
    ])
  })

  test("scrolls the strip instead of overflowing the page", () => {
    render(TABS)

    const className = strip()?.className ?? ""
    expect(className).toContain("overflow-x-auto")
    expect(className).toContain("flex-nowrap")
  })

  test("keeps each tab at its natural width so labels never squeeze", () => {
    render(TABS)

    for (const anchor of Array.from(container.querySelectorAll("a"))) {
      expect(anchor.className).toContain("shrink-0")
      expect(anchor.className).toContain("whitespace-nowrap")
    }
  })

  test("tightens padding on small screens and restores it from md up", () => {
    render(TABS)

    const className = strip()?.className ?? ""
    expect(className).toContain("px-4")
    expect(className).toContain("md:px-8")
    expect(className).toContain("gap-4")
    expect(className).toContain("md:gap-8")
  })

  test("fades the strip's edges only where tabs are off-screen", () => {
    render(TABS)

    const element = strip()
    expect(element?.className).toContain("scroll-fade-x")
    // jsdom lays nothing out, so the strip fits: no edge is marked.
    expect(element?.hasAttribute("data-overflow-start")).toBe(false)
    expect(element?.hasAttribute("data-overflow-end")).toBe(false)
  })

  const withLastTabActive = [
    ...TABS.map((tab) => ({ ...tab, isActive: false })),
    { label: "Error Logs", href: "/error-logs", isActive: true },
  ]

  test("brings an active tab past the end edge into view, clear of the fade", () => {
    const rects = stubRects({ left: 16, right: 372 }, { left: 331, right: 396 })
    try {
      render(withLastTabActive)

      // 396 - 372 to show the tab, plus 24 px so the end fade misses it.
      expect(strip()?.scrollLeft).toBe(48)
    } finally {
      rects.mockRestore()
    }
  })

  test("brings an active tab past the start edge into view (right-to-left)", () => {
    const rects = stubRects({ left: 16, right: 372 }, { left: -40, right: 30 })
    try {
      render(withLastTabActive)

      // Scrolling towards the physical left is negative in an RTL strip.
      expect(strip()?.scrollLeft).toBe(-80)
    } finally {
      rects.mockRestore()
    }
  })

  test("leaves the strip alone when the active tab is visible", () => {
    const rects = stubRects({ left: 16, right: 372 }, { left: 33, right: 83 })
    try {
      render(TABS)

      expect(strip()?.scrollLeft).toBe(0)
    } finally {
      rects.mockRestore()
    }
  })

  test("marks the active tab", () => {
    render(TABS)

    const active = Array.from(container.querySelectorAll("a")).find((anchor) =>
      anchor.className.includes("border-neutral-700"),
    )
    expect(active?.textContent).toBe("General")
  })

  test("renders a disabled tab as a non-link", () => {
    render([
      { label: "General", href: "/settings/general", isActive: true },
      {
        label: "Locked",
        href: "/settings/locked",
        isActive: false,
        disabled: true,
      },
    ])

    const anchors = Array.from(container.querySelectorAll("a")).map(
      (anchor) => anchor.textContent,
    )
    expect(anchors).toEqual(["General"])
    expect(container.textContent).toContain("Locked")
  })
})
