import { act, useRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { useHorizontalOverflow } from "../src/hooks/use-horizontal-overflow"

/**
 * jsdom lays nothing out, so every box reports 0. The geometry the hook reads
 * is stubbed on the prototype and driven per element through `data-*`, which
 * lets a test set it before the effect's first read.
 */
const GEOMETRY = ["scrollWidth", "clientWidth"] as const

function stubGeometry() {
  for (const key of GEOMETRY) {
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get(this: HTMLElement) {
        return Number(this.dataset[key] ?? 0)
      },
    })
  }
}

function restoreGeometry() {
  for (const key of GEOMETRY) {
    // The own-property stub shadows jsdom's getter on Element.prototype.
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key]
  }
}

type Box = { scrollWidth: number; clientWidth: number }

function Strip({ box, watch }: { box: Box; watch?: unknown }) {
  const ref = useRef<HTMLDivElement>(null)
  useHorizontalOverflow(ref, watch)
  return (
    <div
      data-client-width={box.clientWidth}
      data-scroll-width={box.scrollWidth}
      data-testid="strip"
      ref={ref}
    />
  )
}

function NullRef() {
  const ref = useRef<HTMLDivElement>(null)
  useHorizontalOverflow(ref)
  return null
}

describe("useHorizontalOverflow", () => {
  let container: HTMLDivElement
  let root: Root

  const render = (node: React.ReactNode) => {
    act(() => {
      root.render(node)
    })
  }

  const strip = () =>
    container.querySelector<HTMLElement>('[data-testid="strip"]') as HTMLElement

  const scrollTo = (left: number) => {
    act(() => {
      strip().scrollLeft = left
      strip().dispatchEvent(new Event("scroll"))
    })
  }

  const state = () => ({
    start: strip().hasAttribute("data-overflow-start"),
    end: strip().hasAttribute("data-overflow-end"),
  })

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    stubGeometry()
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    restoreGeometry()
    vi.unstubAllGlobals()
  })

  test("marks nothing when the content fits", () => {
    render(<Strip box={{ scrollWidth: 300, clientWidth: 300 }} />)

    expect(state()).toEqual({ start: false, end: false })
  })

  test("marks only the end edge at the start of an overflowing strip", () => {
    render(<Strip box={{ scrollWidth: 600, clientWidth: 300 }} />)

    expect(state()).toEqual({ start: false, end: true })
  })

  test("marks both edges mid-scroll", () => {
    render(<Strip box={{ scrollWidth: 600, clientWidth: 300 }} />)
    scrollTo(150)

    expect(state()).toEqual({ start: true, end: true })
  })

  test("marks only the start edge once scrolled to the end", () => {
    render(<Strip box={{ scrollWidth: 600, clientWidth: 300 }} />)
    scrollTo(300)

    expect(state()).toEqual({ start: true, end: false })
  })

  test("ignores a sub-pixel remainder at either end", () => {
    render(<Strip box={{ scrollWidth: 600, clientWidth: 300 }} />)
    scrollTo(299.5)

    expect(state()).toEqual({ start: true, end: false })

    scrollTo(0.5)

    expect(state()).toEqual({ start: false, end: true })
  })

  test("reads a right-to-left strip, whose scrollLeft runs negative", () => {
    render(<Strip box={{ scrollWidth: 600, clientWidth: 300 }} />)
    scrollTo(-150)

    expect(state()).toEqual({ start: true, end: true })

    scrollTo(-300)

    expect(state()).toEqual({ start: true, end: false })
  })

  test("re-reads when the strip is resized", () => {
    const callbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback)
        }
        observe() {
          // recorded via the constructor
        }
        unobserve() {
          // unused
        }
        disconnect() {
          // unused
        }
      },
    )
    render(<Strip box={{ scrollWidth: 600, clientWidth: 300 }} />)
    expect(state()).toEqual({ start: false, end: true })

    act(() => {
      strip().dataset.clientWidth = "600"
      for (const callback of callbacks) {
        callback([], {} as ResizeObserver)
      }
    })

    expect(state()).toEqual({ start: false, end: false })
  })

  test("re-reads when the watched content changes", () => {
    render(<Strip box={{ scrollWidth: 300, clientWidth: 300 }} watch="a" />)
    expect(state()).toEqual({ start: false, end: false })

    render(<Strip box={{ scrollWidth: 600, clientWidth: 300 }} watch="b" />)

    expect(state()).toEqual({ start: false, end: true })
  })

  test("stops listening on unmount", () => {
    const disconnect = vi.fn()
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {
          // no-op
        }
        unobserve() {
          // no-op
        }
        disconnect = disconnect
      },
    )
    render(<Strip box={{ scrollWidth: 600, clientWidth: 300 }} />)
    const element = strip()
    const removeListener = vi.spyOn(element, "removeEventListener")

    act(() => {
      root.render(null)
    })

    expect(removeListener).toHaveBeenCalledWith("scroll", expect.any(Function))
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  test("does nothing when the ref is never attached", () => {
    expect(() => render(<NullRef />)).not.toThrow()
  })
})
