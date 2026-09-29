import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, test, vi } from "vitest"

/**
 * s220c: at 390 px the bell panel sat 5 px from the left edge and 1 px from
 * the right (Base UI's default collisionPadding + a fixed w-96), and its list
 * painted 76 px past the panel over the sidebar (a ScrollArea root with only
 * a max-height never scrolls). These pin the three causes; the live 390 px
 * measurement is in the PR.
 */

const popoverContentProps: Record<string, unknown>[] = []
const FIXED_W96 = /(^|\s)w-96(\s|$)/
const WHITESPACE = /\s+/

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({ relativeTime: () => "1 minute ago" }),
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock("next/link", () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <a href="/">{children}</a>
  ),
}))
vi.mock("@chatbotx.io/ui/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: () => null,
  PopoverContent: (props: Record<string, unknown>) => {
    popoverContentProps.push(props)
    return (
      <div
        className={String(props.className)}
        data-testid={String(props["data-testid"])}
      >
        {props.children as React.ReactNode}
      </div>
    )
  },
}))

const ROWS = Array.from({ length: 20 }, (_, i) => ({
  id: String(i + 1),
  type: "formSubmitted",
  readAt: null,
  createdAt: new Date("2026-09-29T08:24:00Z").toISOString(),
  dealId: null,
  payload: {
    kind: "form",
    formId: "11715813087330304",
    formTitle: "s220c actions proof",
    contactName: "Guest 9GZCjAMSrw",
  },
}))

vi.mock("@/features/notifications/provider/notification-hook", () => ({
  useUnreadNotificationCount: () => ({ data: 20 }),
  useNotifications: () => ({ data: { data: ROWS }, isPending: false }),
  useMarkNotificationRead: () => ({ mutate: vi.fn() }),
  useMarkAllNotificationsRead: () => ({ mutate: vi.fn(), isPending: false }),
}))

const { NotificationBell } = await import(
  "@/features/notifications/components/notification-bell"
)

let container: HTMLDivElement | null = null
let root: Root | null = null

const render = () => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<NotificationBell workspaceId="11701868563365888" />)
  })
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  popoverContentProps.length = 0
})

describe("notification bell panel layout (s220c)", () => {
  test("keeps 16 px from every viewport edge and never exceeds the viewport width", () => {
    render()
    const props = popoverContentProps.at(-1)
    expect(props?.collisionPadding).toBe(16)
    const cls = String(props?.className)
    expect(cls).toContain("w-[min(24rem,calc(100vw-2rem))]")
    expect(cls).not.toMatch(FIXED_W96)
  })

  test("is bounded by the room below the bell and scrolls its list inside the panel", () => {
    const el = render()
    const panel = el.querySelector('[data-testid="notification-panel"]')
    expect(panel?.className).toContain(
      "max-h-[min(32rem,var(--available-height))]",
    )
    const scroll = el.querySelector('[data-testid="notification-scroll"]')
    expect(scroll?.className.split(WHITESPACE)).toEqual(
      expect.arrayContaining(["min-h-0", "flex-1", "overflow-y-auto"]),
    )
    // Every row lives inside the scroller, so none can paint past the panel.
    expect(
      scroll?.querySelectorAll('[data-testid="notification-row"]'),
    ).toHaveLength(20)
  })

  test("header keeps the title left and both actions together on the right", () => {
    const el = render()
    const header = el.querySelector('[data-testid="notification-panel"] > div')
    expect(header?.className).not.toContain("justify-between")
    const title = header?.firstElementChild
    expect(title?.className.split(WHITESPACE)).toEqual(
      expect.arrayContaining(["flex-1", "min-w-0", "truncate"]),
    )
  })
})
