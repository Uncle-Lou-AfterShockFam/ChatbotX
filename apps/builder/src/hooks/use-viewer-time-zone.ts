"use client"

import { resolveFilterTimezone } from "@chatbotx.io/utils/datetime"
import { useTimeZone } from "next-intl"
import { useSyncExternalStore } from "react"
import { getBrowserTimezone } from "@/features/contact-filter/lib/timezone"

// The browser's zone does not change under a mounted page.
const subscribe = () => () => undefined

/**
 * The zone to show an instant in. The server render and hydration use the
 * request's zone (the `NEXT_TIMEZONE` cookie, or UTC without one), so they
 * match; once hydrated, the browser's own zone. A webchat guest in a
 * third-party iframe never gets the cookie (`TimezoneSync` cannot set it
 * there), so without this their message times read in UTC. For a signed-in
 * user the cookie already holds the browser's zone and nothing changes.
 */
export function useViewerTimeZone(): string {
  const requestZone = useTimeZone() ?? "UTC"
  return useSyncExternalStore(
    subscribe,
    () => {
      const browserZone = getBrowserTimezone()
      return resolveFilterTimezone(browserZone) === browserZone
        ? browserZone
        : requestZone
    },
    () => requestZone,
  )
}
