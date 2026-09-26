import * as React from "react"

/**
 * Layout reports fractional widths on zoomed and high-DPI screens, so a strip
 * scrolled flush to one end can still read half a pixel short of it.
 */
const EDGE_TOLERANCE_PX = 1

/**
 * Marks which edges of a horizontally scrolling element hide content, as
 * `data-overflow-start` / `data-overflow-end` on the element itself. Pair it
 * with the `scroll-fade-x` utility, which fades exactly the marked edges — the
 * cue a `scrollbar-hide` strip otherwise lacks.
 *
 * Attributes rather than state: the strip re-marks on every scroll frame, and
 * re-rendering its children for a purely visual cue would be wasted work.
 *
 * `scrollLeft` runs from 0 towards negative values in a right-to-left strip,
 * so the offset is read as a magnitude and "start" stays the reading start.
 *
 * `watch` re-reads when the caller's content changes without resizing the
 * element itself (a relabelled or added tab), which no observer here sees.
 */
export function useHorizontalOverflow(
  ref: React.RefObject<HTMLElement | null>,
  watch?: unknown,
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `watch` is the caller's re-read signal, not a value the effect reads.
  React.useEffect(() => {
    const element = ref.current
    if (!element) {
      return
    }

    const mark = () => {
      const offset = Math.abs(element.scrollLeft)
      const hidden = element.scrollWidth - element.clientWidth
      element.toggleAttribute(
        "data-overflow-start",
        offset > EDGE_TOLERANCE_PX,
      )
      element.toggleAttribute(
        "data-overflow-end",
        hidden - offset > EDGE_TOLERANCE_PX,
      )
    }

    mark()
    element.addEventListener("scroll", mark, { passive: true })
    const observer = new ResizeObserver(mark)
    observer.observe(element)
    return () => {
      element.removeEventListener("scroll", mark)
      observer.disconnect()
    }
  }, [ref, watch])
}
