import { act } from "react"
import { hydrateRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, describe, expect, test, vi } from "vitest"

// The request's `now` from `i18n/request.ts`, as the provider hands it to
// both the server render and the hydrating client.
const REQUEST_NOW = new Date("2026-09-26T12:00:00Z")
vi.mock("next-intl", () => ({ useNow: () => REQUEST_NOW }))

const { RelativeTime } = await import("@/components/relative-time")

// 90 s before the request: "2 minutes ago" at request time, and the label
// changes by the time the client hydrates 60 s later.
const LAST_READ = new Date(REQUEST_NOW.getTime() - 90_000)

let root: Root | undefined
let container: HTMLElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  vi.useRealTimers()
})

describe("RelativeTime (s205c, React #418 on /contacts)", () => {
  test("hydrates without a mismatch when the clock moved past a unit boundary, then shows the real distance", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })
    vi.setSystemTime(REQUEST_NOW)
    const html = renderToString(<RelativeTime addSuffix date={LAST_READ} />)
    expect(html).toBe("2 minutes ago")

    // The browser hydrates a minute later.
    vi.setSystemTime(new Date(REQUEST_NOW.getTime() + 60_000))
    container = document.createElement("div")
    container.innerHTML = html
    document.body.append(container)
    const recoverable = vi.fn()
    await act(() => {
      root = hydrateRoot(
        container as HTMLElement,
        <RelativeTime addSuffix date={LAST_READ} />,
        { onRecoverableError: recoverable },
      )
    })

    expect(recoverable).not.toHaveBeenCalled()
    expect(container.textContent).toBe("3 minutes ago")

    // And it keeps ticking against the real clock.
    await act(() => {
      vi.advanceTimersByTime(120_000)
    })
    expect(container.textContent).toBe("5 minutes ago")
  })

  test("strict mode prints the strict distance without a suffix by default", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(REQUEST_NOW)
    expect(renderToString(<RelativeTime date={LAST_READ} strict />)).toBe(
      "2 minutes",
    )
  })
})
