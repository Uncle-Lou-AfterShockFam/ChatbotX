"use client"

import { useNow } from "next-intl"
import { useEffect, useState } from "react"

const RENDER_NOW_INTERVAL_MS = 60_000

/**
 * "Now" for a relative-time label. The first render uses the request's `now`
 * (`i18n/request.ts`), which the server render and the hydrating client share,
 * so "3 minutes ago" cannot differ between them (React #418 on `/contacts`
 * when SSR and hydration straddled a minute). After mount it switches to the
 * real clock and re-reads it every minute.
 */
export function useRenderNow(): Date {
  const requestNow = useNow()
  const [now, setNow] = useState(requestNow)

  useEffect(() => {
    setNow(new Date())
    const timer = window.setInterval(
      () => setNow(new Date()),
      RENDER_NOW_INTERVAL_MS,
    )
    return () => window.clearInterval(timer)
  }, [])

  return now
}
