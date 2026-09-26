import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"

const inputProps = vi.fn()
const refProps = vi.fn()
vi.mock("@/features/integration-webchat/webchat-message-input", () => ({
  WebchatMessageInput: (props: { parentOrigin?: string | null }) => {
    inputProps(props.parentOrigin)
    return null
  },
}))
vi.mock("@/features/integration-webchat/components/webchat-ref", () => ({
  default: (props: { parentOrigin?: string | null }) => {
    refProps(props.parentOrigin)
    return null
  },
}))
vi.mock("@/features/integration-webchat/webchat-header", () => ({
  WebchatHeader: () => null,
}))
vi.mock("@/features/integration-webchat/webchat-message-list", () => ({
  WebchatMessageList: () => null,
}))
vi.mock("@/features/integration-webchat/webchat-realtime", () => ({
  WebchatRealtime: () => null,
}))

const { GuestSessionStoreProvider } = await import(
  "@/features/integration-webchat/providers/store/guest-session-provider"
)
const { WebchatWrapper } = await import(
  "@/features/integration-webchat/webchat-wrapper"
)

let root: Root | undefined
let container: HTMLElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

const tree = (parentOrigin: string | null) => (
  <GuestSessionStoreProvider
    accessToken="token"
    config={{ id: "webchat-1", workspaceId: "workspace-1" } as never}
    parentOrigin={parentOrigin}
    serverGuestConversationId="workspace-1:guest"
  >
    <WebchatWrapper />
  </GuestSessionStoreProvider>
)

test("send and ref keep the origin the token was minted with across a server re-render (s209)", () => {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  act(() => root?.render(tree(null)))
  // TimezoneSync's refresh on a top-level open re-renders with the hub as
  // Referer; the store (and the token in it) is kept.
  act(() => root?.render(tree("https://chat.example/webchat?x=1")))

  expect(inputProps).toHaveBeenLastCalledWith(null)
  expect(refProps).toHaveBeenLastCalledWith(null)
})
