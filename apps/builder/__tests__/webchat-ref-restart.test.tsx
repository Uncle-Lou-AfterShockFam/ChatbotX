import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, test, vi } from "vitest"
import { GUEST_SECRET_REFUSED_MESSAGE } from "@/features/integration-webchat/lib/guest-conversation-id"

// s215 probe: WebchatRef's init is what fires the welcome flow and a `?ref=`
// entry flow. It must send the guest secret, and a refused secret must start
// the fresh conversation (the wrapper keys WebchatRef on the id, so the new
// session runs its own init).
const hoisted = vi.hoisted(() => ({
  execute: vi.fn(),
  options: {} as {
    onError?: (args: { error: { serverError?: string } }) => void
  },
  restartGuestSession: vi.fn(),
}))
vi.mock("next-safe-action/hooks", () => ({
  useAction: (_action: unknown, options: typeof hoisted.options) => {
    hoisted.options = options ?? {}
    return { execute: hoisted.execute }
  },
}))
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("@/features/messages/actions/create-webchat-message.action", () => ({
  createWebchatMessageAction: {},
}))
vi.mock(
  "@/features/integration-webchat/providers/store/guest-session-provider",
  () => ({
    useGuestSessionStore: (select: (s: unknown) => unknown) =>
      select({ restartGuestSession: hoisted.restartGuestSession }),
  }),
)

const { default: WebchatRef } = await import(
  "@/features/integration-webchat/components/webchat-ref"
)

const ID = "123:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f"
const SECRET = "a".repeat(64)

let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.clearAllMocks()
})

const render = (guestSecret: string) => {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  act(() =>
    root?.render(
      <WebchatRef
        guestConversationId={ID}
        guestSecret={guestSecret}
        webchatId="2"
        workspaceId="123"
      />,
    ),
  )
}

describe("WebchatRef init (s215)", () => {
  test("sends the guest secret with the init", () => {
    render(SECRET)
    expect(hoisted.execute).toHaveBeenCalledTimes(1)
    expect(hoisted.execute.mock.calls[0]?.[0]).toMatchObject({
      guestConversationId: ID,
      guestSecret: SECRET,
      init: true,
    })
  })

  test("waits for a secret: no init with the id alone", () => {
    render("")
    expect(hoisted.execute).not.toHaveBeenCalled()
  })

  test("a refused secret restarts the session; any other error does not", () => {
    render(SECRET)
    hoisted.options.onError?.({ error: { serverError: "Too many requests" } })
    expect(hoisted.restartGuestSession).not.toHaveBeenCalled()
    hoisted.options.onError?.({
      error: { serverError: GUEST_SECRET_REFUSED_MESSAGE },
    })
    expect(hoisted.restartGuestSession).toHaveBeenCalledTimes(1)
  })
})
