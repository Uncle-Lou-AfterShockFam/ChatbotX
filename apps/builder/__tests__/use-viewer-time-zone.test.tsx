import { act } from "react"
import { hydrateRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, describe, expect, test, vi } from "vitest"

// A webchat guest: no zone cookie, so the request resolved UTC.
vi.mock("next-intl", () => ({ useTimeZone: () => "UTC" }))
const browser = vi.hoisted(() => ({ zone: "America/New_York" }))
vi.mock("@/features/contact-filter/lib/timezone", () => ({
  getBrowserTimezone: () => browser.zone,
}))

const { useViewerTimeZone } = await import("@/hooks/use-viewer-time-zone")

function Zone() {
  return <>{useViewerTimeZone()}</>
}

let root: Root | undefined
let container: HTMLElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  browser.zone = "America/New_York"
})

async function hydrate() {
  const html = renderToString(<Zone />)
  container = document.createElement("div")
  container.innerHTML = html
  document.body.append(container)
  const recoverable = vi.fn()
  await act(() => {
    root = hydrateRoot(container as HTMLElement, <Zone />, {
      onRecoverableError: recoverable,
    })
  })
  return { html, recoverable, text: container.textContent }
}

describe("useViewerTimeZone (s205c, webchat guests saw UTC)", () => {
  test("the server renders the request zone; the hydrated page shows the browser's, with no mismatch", async () => {
    const { html, recoverable, text } = await hydrate()
    expect(html).toBe("UTC")
    expect(recoverable).not.toHaveBeenCalled()
    expect(text).toBe("America/New_York")
  })

  test("a browser zone this runtime cannot resolve keeps the request zone", async () => {
    browser.zone = "Not/AZone"
    const { recoverable, text } = await hydrate()
    expect(recoverable).not.toHaveBeenCalled()
    expect(text).toBe("UTC")
  })
})
