import { act, useContext } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  TOKEN_TTL_SECONDS,
  WEBCHAT_TOKEN_REFRESH_LEAD_MS,
} from "@/features/integration-webchat/lib/webchat-token-expiry"
import type { TokenRefreshOutcome } from "@/features/integration-webchat/providers/store/guest-sesssion-store"

vi.mock("@/features/messages/actions/create-webchat-message.action", () => ({
  createWebchatMessageAction: {},
}))

const refresh = vi.hoisted(() =>
  vi.fn<() => Promise<TokenRefreshOutcome>>(async () => "refreshed"),
)
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

// s210: the refresh is timed from when the token arrived (client clock), so
// the token content is irrelevant here.
const DUE_MS = TOKEN_TTL_SECONDS * 1000 - WEBCHAT_TOKEN_REFRESH_LEAD_MS
const NOW = new Date("2026-09-27T12:00:00Z").getTime()

type StoreApi = {
  setState: (s: {
    accessToken?: string
    accessTokenReceivedAt?: number
  }) => void
}
let root: Root | undefined
let container: HTMLDivElement | undefined
let storeApi: StoreApi | undefined

function Capture() {
  storeApi = useContext(GuestSessionStoreContext) as unknown as StoreApi
  return null
}

const mount = () => {
  container = document.createElement("div")
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container as HTMLDivElement)
    root.render(
      <GuestSessionStoreProvider
        accessToken="token"
        config={{ id: "42", workspaceId: "1", persistentMenus: [] } as never}
        serverGuestConversationId="123:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f"
      >
        <Capture />
      </GuestSessionStoreProvider>,
    )
  })
}
const unmount = () => {
  act(() => root?.unmount())
  root = undefined
}
const newToken = () =>
  act(() =>
    storeApi?.setState({
      accessToken: "fresh",
      accessTokenReceivedAt: Date.now(),
    }),
  )

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  refresh.mockReset().mockResolvedValue("refreshed")
})
afterEach(() => {
  unmount()
  container?.remove()
  vi.useRealTimers()
})

describe("guest token refresh schedule (s210)", () => {
  test("refreshes the lead time before the TTL, then reschedules from the new token", async () => {
    mount()
    await act(() => vi.advanceTimersByTimeAsync(DUE_MS - 1))
    expect(refresh).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(refresh).toHaveBeenCalledTimes(1)

    newToken()
    await act(() => vi.advanceTimersByTimeAsync(DUE_MS - 1))
    expect(refresh).toHaveBeenCalledTimes(1)
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  test("a new token that arrives every time never loops faster than the TTL", async () => {
    refresh.mockImplementation(() => {
      storeApi?.setState({ accessTokenReceivedAt: Date.now() })
      return Promise.resolve("refreshed")
    })
    mount()
    await act(() => vi.advanceTimersByTimeAsync(3 * DUE_MS + 10))
    expect(refresh).toHaveBeenCalledTimes(3)
  })

  test("failures retry a bounded number of times; refusals do not retry", async () => {
    refresh.mockResolvedValue("failed")
    mount()
    await act(() => vi.advanceTimersByTimeAsync(DUE_MS + 10 * 60 * 1000))
    expect(refresh).toHaveBeenCalledTimes(4) // first try + 3 retries

    unmount()
    refresh.mockReset().mockResolvedValue("refused")
    mount()
    await act(() => vi.advanceTimersByTimeAsync(DUE_MS + 10 * 60 * 1000))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test("a token renewed elsewhere resets the retry budget", async () => {
    refresh.mockResolvedValue("failed")
    mount()
    await act(() => vi.advanceTimersByTimeAsync(DUE_MS + 10 * 60 * 1000))
    expect(refresh).toHaveBeenCalledTimes(4)
    newToken() // e.g. the 403 retry path refreshed it
    await act(() => vi.advanceTimersByTimeAsync(DUE_MS + 10 * 60 * 1000))
    expect(refresh).toHaveBeenCalledTimes(8)
  })

  test("a tab waking up past due refreshes at once", async () => {
    mount()
    vi.setSystemTime(NOW + DUE_MS + 1) // slept; the timer has not fired
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test("unmount stops everything, even a refresh that fails after it", async () => {
    let fail: (outcome: TokenRefreshOutcome) => void = () => undefined
    refresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          fail = resolve
        }),
    )
    mount()
    await act(() => vi.advanceTimersByTimeAsync(DUE_MS))
    expect(refresh).toHaveBeenCalledTimes(1)
    unmount()
    fail("failed")
    await act(() => vi.advanceTimersByTimeAsync(60 * 60 * 1000))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("the timer and a wake-up firing together make one run and one retry", async () => {
    let settle: (outcome: TokenRefreshOutcome) => void = () => undefined
    refresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve
        }),
    )
    refresh.mockResolvedValue("refreshed")
    mount()
    await act(() => vi.advanceTimersByTimeAsync(DUE_MS)) // timer fires, pending
    act(() => {
      document.dispatchEvent(new Event("visibilitychange")) // wake, same moment
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    await act(async () => {
      settle("failed")
      await Promise.resolve()
    })
    await act(() => vi.advanceTimersByTimeAsync(60 * 1000))
    expect(refresh).toHaveBeenCalledTimes(2) // exactly one retry
  })
})
