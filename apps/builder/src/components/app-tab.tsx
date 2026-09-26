"use client"

import { Card, CardContent } from "@chatbotx.io/ui/components/ui/card"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@chatbotx.io/ui/components/ui/tooltip"
import { useHorizontalOverflow } from "@chatbotx.io/ui/hooks/use-horizontal-overflow"
import Link from "next/link"
import { useEffect, useRef } from "react"

type AppTabProps = {
  tabs: {
    label: string
    href: string
    isActive: boolean
    disabled?: boolean
    disabledPresentation?: "muted" | "normal"
    disabledTooltip?: string
  }[]
}

function getTabClassName(tab: AppTabProps["tabs"][number]) {
  // `shrink-0` + `whitespace-nowrap` keep each tab at its natural width so
  // the strip overflows (and scrolls) instead of squeezing labels.
  const base = "shrink-0 whitespace-nowrap border-b-2 py-4 text-sm md:py-6"
  if (tab.disabled) {
    const disabledPresentation =
      tab.disabledPresentation === "normal"
        ? "text-gray-800 dark:text-gray-400"
        : "text-gray-400 opacity-60 dark:text-gray-500"
    return `${base} cursor-not-allowed border-transparent font-medium ${disabledPresentation}`
  }
  if (tab.isActive) {
    return `${base} border-neutral-700 dark:border-white dark:text-gray-50`
  }
  return `${base} border-transparent font-medium text-gray-800 dark:text-gray-400`
}

/**
 * Room past the revealed tab, matching `scroll-fade-x`'s 1.5rem fade: a tab
 * scrolled exactly flush with the edge would sit under that fade.
 */
const REVEAL_CLEARANCE_PX = 24

/**
 * Scrolls the strip just far enough to show the active tab whole: a deep link
 * to the last tab ("Error Logs") otherwise lands with its label cut at a
 * phone's edge. Box edges are compared on screen, so the maths is the same in
 * a right-to-left strip, whose `scrollLeft` runs negative: the physical axis
 * is shared, and the browser clamps an overshoot to the scroll range, which
 * for the last tab means flush with the end and its fade gone. `scrollLeft` is
 * set directly rather than via `scrollIntoView`, which would scroll the page.
 */
function revealActiveTab(strip: HTMLElement) {
  const active = strip.querySelector<HTMLElement>('[aria-current="page"]')
  if (!active) {
    return
  }
  const view = strip.getBoundingClientRect()
  const tab = active.getBoundingClientRect()
  if (tab.right > view.right) {
    strip.scrollLeft += tab.right - view.right + REVEAL_CLEARANCE_PX
  } else if (tab.left < view.left) {
    strip.scrollLeft -= view.left - tab.left + REVEAL_CLEARANCE_PX
  }
}

export function AppTab({ tabs }: AppTabProps) {
  const stripRef = useRef<HTMLDivElement>(null)
  const layoutKey = tabs
    .map((tab) => `${tab.href}:${tab.label}:${tab.isActive}`)
    .join("|")

  // Declared before the overflow hook so its first read sees the revealed
  // position, not the one the reveal is about to leave.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the tabs or the active one change.
  useEffect(() => {
    if (stripRef.current) {
      revealActiveTab(stripRef.current)
    }
  }, [layoutKey])
  useHorizontalOverflow(stripRef, layoutKey)

  return (
    <Card className="py-0">
      {/*
        Several surfaces render 5-6 tabs, which cannot fit a phone. Scrolling
        the strip keeps every tab reachable without pushing the page itself
        into horizontal overflow. The scrollbar is hidden because the strip
        sits directly under a card edge, where a persistent bar reads as a
        rendering artefact; touch scrolling needs no visible track, and
        `scroll-fade-x` fades whichever edge hides tabs instead.
      */}
      <CardContent
        className="scrollbar-hide scroll-fade-x flex flex-nowrap items-center gap-4 overflow-x-auto px-4 md:gap-8 md:px-8"
        ref={stripRef}
      >
        {tabs.map((tab) =>
          tab.disabled ? (
            <Tooltip key={tab.href}>
              <TooltipTrigger
                render={
                  <span
                    aria-disabled="true"
                    className={getTabClassName(tab)}
                    title={tab.disabledTooltip}
                  >
                    {tab.label}
                  </span>
                }
              />
              {tab.disabledTooltip ? (
                <TooltipContent>{tab.disabledTooltip}</TooltipContent>
              ) : null}
            </Tooltip>
          ) : (
            <Link
              aria-current={tab.isActive ? "page" : undefined}
              className={getTabClassName(tab)}
              href={tab.href}
              key={tab.href}
            >
              {tab.label}
            </Link>
          ),
        )}
      </CardContent>
    </Card>
  )
}
