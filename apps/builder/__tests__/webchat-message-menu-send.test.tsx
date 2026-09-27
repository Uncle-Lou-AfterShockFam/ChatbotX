import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, test, vi } from "vitest"

// s212 skeptic: the menu's one-click guard was released when the token await
// settled, before the send ran, so a double click ran the flow twice.
const executeAsync = vi.hoisted(() => vi.fn())
vi.mock("next-safe-action/hooks", () => ({
  useAction: () => ({ execute: executeAsync, executeAsync }),
}))
vi.mock("@/features/messages/actions/create-webchat-message.action", () => ({
  createWebchatMessageAction: {},
}))
// Plain elements: the menu under test is the click handler, not base-ui.
vi.mock("@chatbotx.io/ui/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: unknown }) => children,
  DropdownMenuTrigger: () => null,
  DropdownMenuContent: ({ children }: { children: unknown }) => children,
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: unknown
    onClick?: () => void
  }) => (
    <button onClick={onClick} type="button">
      {children as string}
    </button>
  ),
}))
const freshAccessToken = vi.hoisted(() => vi.fn(async () => "TOKEN"))
// One state object: a new getMenus per render would re-run the menu's effect
// forever.
const state = vi.hoisted(() => ({
  getMenus: () => [{ type: "flow", flowId: "7", label: "Start" }],
  appendMessage: () => undefined,
  markSendFailed: () => undefined,
  guestConversationId: "123:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
}))
vi.mock(
  "@/features/integration-webchat/providers/store/guest-session-provider",
  () => ({
    useGuestSessionStore: (select: (s: unknown) => unknown) =>
      select({ ...state, freshAccessToken }),
  }),
)

const { default: WebchatMessageMenu } = await import(
  "@/features/integration-webchat/components/webchat-message-menu"
)

let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  executeAsync.mockReset()
})

describe("webchat menu flow send (s212)", () => {
  test("a second click while the first send is in flight sends nothing", async () => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    let finish: () => void = () => undefined
    executeAsync.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    await act(async () => {
      root?.render(<WebchatMessageMenu webchatId="42" workspaceId="1" />)
      await Promise.resolve()
    })
    const item = container.querySelector("button")
    await act(async () => {
      item?.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    // The token await has settled and the send is in flight.
    expect(executeAsync).toHaveBeenCalledTimes(1)
    await act(async () => {
      item?.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(executeAsync).toHaveBeenCalledTimes(1)
    await act(async () => {
      finish()
      await new Promise((r) => setTimeout(r, 0))
    })
    await act(async () => {
      item?.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(executeAsync).toHaveBeenCalledTimes(2)
  })
})
