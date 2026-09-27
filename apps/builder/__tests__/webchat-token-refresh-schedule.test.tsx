import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { WEBCHAT_TOKEN_REFRESH_LEAD_MS } from "@/features/integration-webchat/lib/webchat-token-expiry"

vi.mock("@/features/messages/actions/create-webchat-message.action", () => ({
  createWebchatMessageAction: {},
}))

const refresh = vi.hoisted(() => vi.fn(async () => true))
vi.mock(
  "@/features/integration-webchat/providers/store/guest-sesssion-store",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/features/integration-webchat/providers/store/guest-sesssion-store")
      >()
    return {
      ...actual,
      createGuestSessionStore: (
        ...args: Parameters<typeof actual.createGuestSessionStore>
      ) => {
        const store = actual.createGuestSessionStore(...args)
        store.setState({ refreshAccessToken: refresh })
        return store
      },
    }
  },
)

const { GuestSessionStoreProvider, GuestSessionStoreContext } = await import(
  "@/features/integration-webchat/providers/store/guest-session-provider"
)
const { useContext } = await import("react")

const NOW = new Date("2026-09-27T12:00:00Z").getTime()
const tokenExpiringIn = (ms: number) =>
  `${btoa(JSON.stringify({ exp: (Date.now() + ms) / 1000 }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")}.sig`

let root: Root | undefined
let container: HTMLDivElement | undefined
let storeApi: ReturnType<typeof useContext<unknown>> | undefined

function Capture() {
  storeApi = useContext(GuestSessionStoreContext)
  return null
}

const mount = (token: string | null) => {
  container = document.createElement("div")
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container as HTMLDivElement)
    root.render(
      <GuestSessionStoreProvider
        accessToken={token}
        config={{ id: "42", workspaceId: "1", persistentMenus: [] } as never}
        serverGuestConversationId="123:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f"
      >
        <Capture />
      </GuestSessionStoreProvider>,
    )
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  refresh.mockReset().mockResolvedValue(true)
})
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.useRealTimers()
})

describe("guest token refresh schedule (s210)", () => {
  test("refreshes the lead time before expiry, then reschedules from the new token", async () => {
    mount(tokenExpiringIn(30 * 60 * 1000))
    await act(() =>
      vi.advanceTimersByTimeAsync(
        30 * 60 * 1000 - WEBCHAT_TOKEN_REFRESH_LEAD_MS - 1,
      ),
    )
    expect(refresh).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(refresh).toHaveBeenCalledTimes(1)

    // A new token arrives: the next refresh follows it, not the old one.
    const store = storeApi as {
      setState: (s: { accessToken: string }) => void
    }
    act(() => store.setState({ accessToken: tokenExpiringIn(60 * 60 * 1000) }))
    await act(() => vi.advanceTimersByTimeAsync(40 * 60 * 1000))
    expect(refresh).toHaveBeenCalledTimes(1)
    await act(() => vi.advanceTimersByTimeAsync(20 * 60 * 1000))
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  test("a failed refresh retries a bounded number of times", async () => {
    refresh.mockResolvedValue(false)
    mount(tokenExpiringIn(WEBCHAT_TOKEN_REFRESH_LEAD_MS))
    await act(() => vi.advanceTimersByTimeAsync(0))
    await act(() => vi.advanceTimersByTimeAsync(10 * 60 * 1000))
    expect(refresh).toHaveBeenCalledTimes(4) // first try + 3 retries
  })

  test("a tab waking up inside the lead window refreshes at once", async () => {
    mount(tokenExpiringIn(60 * 60 * 1000))
    vi.setSystemTime(NOW + 59 * 60 * 1000) // slept; the timer has not fired
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test("no readable token: nothing is scheduled; unmount clears the timer", async () => {
    mount("not-a-token")
    await act(() => vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000))
    expect(refresh).not.toHaveBeenCalled()
    act(() => root?.unmount())
    root = undefined
    mount(tokenExpiringIn(10 * 60 * 1000))
    act(() => root?.unmount())
    root = undefined
    await act(() => vi.advanceTimersByTimeAsync(60 * 60 * 1000))
    expect(refresh).not.toHaveBeenCalled()
  })
})
