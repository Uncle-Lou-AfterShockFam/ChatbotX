import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ScrollFadeStrip } from "@/components/scroll-fade-strip"

/** jsdom lays nothing out: report a strip `hidden` px wider than its box. */
function stubOverflow(hidden: number) {
  const scrollWidth = vi
    .spyOn(HTMLElement.prototype, "scrollWidth", "get")
    .mockReturnValue(300 + hidden)
  const clientWidth = vi
    .spyOn(HTMLElement.prototype, "clientWidth", "get")
    .mockReturnValue(300)
  return () => {
    scrollWidth.mockRestore()
    clientWidth.mockRestore()
  }
}

describe("ScrollFadeStrip (s205c)", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const strip = () => container.firstElementChild as HTMLElement

  test("scrolls with a hidden bar and the fade utility, keeping the caller's classes", () => {
    act(() =>
      root.render(<ScrollFadeStrip className="flex gap-2">x</ScrollFadeStrip>),
    )
    for (const token of [
      "overflow-x-auto",
      "scrollbar-hide",
      "scroll-fade-x",
      "flex",
      "gap-2",
    ]) {
      expect(strip().classList).toContain(token)
    }
  })

  test("marks the end edge while content hides past it, and no edge when it fits", () => {
    const restore = stubOverflow(120)
    try {
      act(() => root.render(<ScrollFadeStrip>x</ScrollFadeStrip>))
      expect(strip().hasAttribute("data-overflow-start")).toBe(false)
      expect(strip().hasAttribute("data-overflow-end")).toBe(true)
    } finally {
      restore()
    }

    // A re-read (new `watch`) after the content shrank to fit clears it.
    act(() => root.render(<ScrollFadeStrip watch="fits">x</ScrollFadeStrip>))
    expect(strip().hasAttribute("data-overflow-end")).toBe(false)
  })
})
