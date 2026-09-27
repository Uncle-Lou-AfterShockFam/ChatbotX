// @vitest-environment jsdom

import { act } from "react"
import { hydrateRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { useAdsFilterPreset } from "@/features/ads/hooks/use-ads-filter-preset"
import { parseLocalDateKey } from "@/features/ads/lib/ads-date-key"

// Local noon, so "today" is the same calendar day in any test process zone.
const NOW = new Date(2026, 8, 27, 12, 0, 0)

function Probe({ from, to }: { from: string; to: string }) {
  const { hydrated, preset } = useAdsFilterPreset({
    from: parseLocalDateKey(from),
    to: parseLocalDateKey(to),
  })
  return <span>{`${hydrated}:${preset}`}</span>
}

describe("useAdsFilterPreset (s214: no process-zone preset during SSR)", () => {
  let container: HTMLDivElement
  let root: Root | undefined

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(NOW)
    container = document.createElement("div")
    document.body.append(container)
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    container.remove()
    vi.useRealTimers()
  })

  test("the server render never resolves a preset, even for today's Last 7 days", () => {
    const html = renderToString(<Probe from="2026-09-21" to="2026-09-27" />)
    expect(html).toContain("false:custom")
  })

  test("hydrating the server HTML raises no mismatch, then resolves the preset", () => {
    const props = { from: "2026-09-21", to: "2026-09-27" }
    container.innerHTML = renderToString(<Probe {...props} />)
    const onRecoverableError = vi.fn()
    act(() => {
      root = hydrateRoot(container, <Probe {...props} />, {
        onRecoverableError,
      })
    })
    expect(onRecoverableError).not.toHaveBeenCalled()
    expect(container.textContent).toBe("true:last7")
  })

  test("a range that matches no preset stays custom after hydration", () => {
    const props = { from: "2026-09-02", to: "2026-09-05" }
    container.innerHTML = renderToString(<Probe {...props} />)
    act(() => {
      root = hydrateRoot(container, <Probe {...props} />)
    })
    expect(container.textContent).toBe("true:custom")
  })
})
