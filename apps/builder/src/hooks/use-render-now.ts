"use client"

import { useNow } from "next-intl"
import { useSyncExternalStore } from "react"

const RENDER_NOW_INTERVAL_MS = 60_000

// One clock for every relative label on the page, re-read each minute while
// anything is subscribed. A stable Date between ticks, as
// useSyncExternalStore requires of a snapshot.
let clock = new Date()
const listeners = new Set<() => void>()
let timer: number | undefined

function readClock(): Date {
  if (Date.now() - clock.getTime() >= RENDER_NOW_INTERVAL_MS) {
    clock = new Date()
  }
  return clock
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (timer === undefined) {
    timer = window.setInterval(() => {
      clock = new Date()
      for (const notify of listeners) {
        notify()
      }
    }, RENDER_NOW_INTERVAL_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      window.clearInterval(timer)
      timer = undefined
    }
  }
}

/**
 * "Now" for a relative-time label. The server render and the hydration pass
 * both read the request's `now` (`i18n/request.ts`), so "3 minutes ago"
 * cannot differ between them (React #418 on `/contacts` when they straddled
 * a minute). Everything after hydration, including a label first mounted by
 * a client navigation hours later, reads the shared clock above: the
 * provider's `now` stays frozen at the first page load of the tab.
 */
export function useRenderNow(): Date {
  const requestNow = useNow()
  return useSyncExternalStore(subscribe, readClock, () => requestNow)
}
