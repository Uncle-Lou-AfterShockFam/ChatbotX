"use client"

import { useHorizontalOverflow } from "@chatbotx.io/ui/hooks/use-horizontal-overflow"
import { cn } from "@chatbotx.io/ui/lib/utils"
import { type ReactNode, useRef } from "react"

/**
 * A horizontal scroller with a hidden scrollbar that fades whichever edge
 * hides content (`useHorizontalOverflow` + `scroll-fade-x`), so a phone user
 * can see the row scrolls. `watch` re-reads when the children change without
 * resizing the strip.
 */
export function ScrollFadeStrip({
  className,
  watch,
  children,
}: {
  className?: string
  watch?: unknown
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useHorizontalOverflow(ref, watch)
  return (
    <div
      className={cn("scrollbar-hide scroll-fade-x overflow-x-auto", className)}
      ref={ref}
    >
      {children}
    </div>
  )
}
